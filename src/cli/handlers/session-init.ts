// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback as defaultExecuteWithWorkerFallback,
  getSessionInitRequestTimeoutMs as defaultGetSessionInitRequestTimeoutMs,
  isWorkerFallback as defaultIsWorkerFallback,
  consumeWorkerOutageNotice as defaultConsumeWorkerOutageNotice,
  type WorkerFallbackOptions,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { shouldTrackProject as defaultShouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce as defaultLoadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  logServerFallback as defaultLogServerFallback,
  type ServerRuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

const defaultDependencies = {
  executeWithWorkerFallback: defaultExecuteWithWorkerFallback,
  getSessionInitRequestTimeoutMs: defaultGetSessionInitRequestTimeoutMs,
  isWorkerFallback: defaultIsWorkerFallback,
  consumeWorkerOutageNotice: defaultConsumeWorkerOutageNotice,
  loadFromFileOnce: defaultLoadFromFileOnce,
  resolveRuntimeContext: defaultResolveRuntimeContext,
  logServerFallback: defaultLogServerFallback,
  shouldTrackProject: defaultShouldTrackProject,
};

let dependencies = defaultDependencies;

// #3434 / plan-17 step 3: UserPromptSubmit is synchronous, so the whole
// session-init round-trip spends ONE budget (getSessionInitRequestTimeoutMs)
// that stays inside the host's 15 s hook timeout. The server runtime gets half
// of it, so a server fallback still leaves the worker path a real share.
const SESSION_INIT_SERVER_TIMEOUT_DIVISOR = 2;
const SESSION_INIT_MIN_REMAINING_TIMEOUT_MS = 500;
const CODEX_SESSION_INIT_REQUEST_TIMEOUT_MS = 2_000;

export function setSessionInitDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!dependencies.shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);
    const settings = dependencies.loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';

    const runtime = dependencies.resolveRuntimeContext();
    const sessionInitStartedAt = Date.now();
    const sessionInitTimeoutMs = dependencies.getSessionInitRequestTimeoutMs();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. Legacy `'server-beta'` is normalized inside `selectRuntime()`.
    if (runtime.runtime === 'server') {
      try {
        await startServerSession(
          runtime,
          input,
          sessionId,
          platformSource,
          project,
          prompt,
          Math.max(
            SESSION_INIT_MIN_REMAINING_TIMEOUT_MS,
            Math.floor(sessionInitTimeoutMs / SESSION_INIT_SERVER_TIMEOUT_DIVISOR),
          ),
        );
        // Server does not currently support the same context-injection
        // protocol as the worker. Skip semantic injection in server mode
        // until the server context endpoint exists.
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          dependencies.logServerFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/start',
          });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server session-start failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });
    const initTimeoutMs = remainingSessionInitTimeoutMs(sessionInitStartedAt, sessionInitTimeoutMs);
    if (initTimeoutMs < SESSION_INIT_MIN_REMAINING_TIMEOUT_MS) {
      logger.warn('HOOK', 'session-init: skipping the worker call because the prompt budget is spent', {
        contentSessionId: sessionId,
        project,
        remainingMs: initTimeoutMs,
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const initResult = await dependencies.executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
      },
      workerSessionInitOptions(platformSource, initTimeoutMs),
    );

    if (dependencies.isWorkerFallback(initResult)) {
      // The prompt always goes through. Once an outage has tripped the
      // fail-loud latch, tell the user once per session: UserPromptSubmit is
      // synchronous, so its systemMessage is shown to them.
      const outageNotice = await dependencies.consumeWorkerOutageNotice(sessionId);
      return {
        continue: true,
        suppressOutput: true,
        exitCode: HOOK_EXIT_CODES.SUCCESS,
        ...(outageNotice ? { systemMessage: outageNotice } : {}),
      };
    }

    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticTimeoutMs = remainingSessionInitTimeoutMs(sessionInitStartedAt, sessionInitTimeoutMs);
      if (semanticTimeoutMs < SESSION_INIT_MIN_REMAINING_TIMEOUT_MS) {
        logger.warn('HOOK', 'session-init: skipping semantic injection because the prompt budget is spent', {
          contentSessionId: sessionId,
          project,
          remainingMs: semanticTimeoutMs,
        });
      } else {
        const semanticResult = await dependencies.executeWithWorkerFallback<SemanticContextResponse>(
          '/api/context/semantic',
          'POST',
          { q: prompt, project, limit, platformSource },
          workerSessionInitOptions(platformSource, semanticTimeoutMs),
        );
        if (!dependencies.isWorkerFallback(semanticResult) && semanticResult?.context) {
          logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
          additionalContext = semanticResult.context;
        }
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};

async function startServerSession(
  runtime: ServerRuntimeContext,
  input: NormalizedHookInput,
  sessionId: string,
  platformSource: string,
  project: string,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  await runtime.client.startSession({
    projectId: runtime.projectId,
    externalSessionId: sessionId,
    contentSessionId: sessionId,
    agentId: input.agentId ?? null,
    agentType: input.agentType ?? null,
    platformSource,
    metadata: { project, prompt },
  }, { timeoutMs });
  logger.info('HOOK', 'session-init: server session started', {
    contentSessionId: sessionId,
    project,
  });
}

function parseSemanticInjectLimit(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}

function remainingSessionInitTimeoutMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

/**
 * Codex keeps main's bounded startup (its 20 s hook timeout in
 * codex-hooks.json already covers the 15 s startup wait plus a 2 s request).
 * Its request is still capped at what is left of the prompt budget, so a
 * shorter CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS bounds Codex requests too.
 * Every other host spends the remaining prompt budget on the whole call.
 */
function workerSessionInitOptions(platformSource: string, budgetLeftMs: number): WorkerFallbackOptions {
  if (platformSource === 'codex') {
    return {
      workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT,
      timeoutMs: Math.min(CODEX_SESSION_INIT_REQUEST_TIMEOUT_MS, budgetLeftMs),
    };
  }
  return { timeoutMs: budgetLeftMs };
}
