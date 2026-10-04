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
import { isCodexInternalPrompt, isInternalProtocolPayload } from '../../utils/tag-stripping.js';
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

/**
 * The worker did not record the prompt for a reason that passes: it was
 * unreachable, answered 429/5xx, or the budget ran out before the call. Only
 * recordSessionPrompt throws this; the hook handler stays fail-open.
 *
 * A rejection that does not pass (a server-runtime 4xx, a reply the hook
 * cannot read) is not thrown: a retry could never succeed, and the transcript
 * watcher would stop on that turn for good, holding back every later turn in
 * the file. It is logged and the turn moves on.
 */
export class SessionPromptNotRecordedError extends Error {
  constructor(readonly reason: string) {
    super(`session-init did not record the prompt (${reason})`);
    this.name = 'SessionPromptNotRecordedError';
  }
}

export const sessionInitHandler: EventHandler = {
  execute(input: NormalizedHookInput): Promise<HookResult> {
    return sessionInit.run(input, false);
  },
};

/**
 * The transcript watcher's anchor for a turn (#3653): the hook's own path,
 * except that a prompt the worker did not record throws
 * SessionPromptNotRecordedError instead of returning the fail-open no-op, so
 * the watcher retries the turn rather than filing its observations under no
 * prompt. Deliberate skips (excluded project, internal or private prompt)
 * still return normally.
 */
export function recordSessionPrompt(input: NormalizedHookInput): Promise<HookResult> {
  return sessionInit.run(input, true);
}

/**
 * Is this event from Qwen Code?
 *
 * Qwen runs the same `hook claude-code session-init` command as Claude Code, so
 * `platform` cannot tell the two hosts apart. Its transcripts live under
 * `~/.qwen/`, which is the one host-specific thing on the event. Matched as a
 * whole path segment so a project directory like `~/.qwen-notes/` is not
 * mistaken for the host.
 */
export const isQwenTranscriptPath = (transcriptPath: string | undefined): boolean => {
  if (!transcriptPath) return false;
  return transcriptPath.replace(/\\/g, '/').includes('/.qwen/');
};

const sessionInit = {
  async run(input: NormalizedHookInput, requireRecordedPrompt: boolean): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt, submittedPrompt } = input;
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

    // Codex runs its own helper threads (task titles, memory consolidation,
    // suggestions) through the same hook as a user turn. Codex only: the same
    // text from another host is a person's prompt.
    if (rawPrompt && normalizePlatformSource(input.platform) === 'codex' && isCodexInternalPrompt(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping a Codex internal helper prompt', {
        reason: 'internal_system_prompt',
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    // The host says this send carried no user-submitted text, so it is a
    // continuation, retry, or tool-result send rather than a user turn. The
    // `[media prompt]` placeholder is for genuinely image-only submissions
    // (#928); storing it here wrote a fake prompt row for every tool round of
    // an agent loop, and the session itself already exists from the turn that
    // WAS submitted.
    if (submittedPrompt === null) {
      logger.debug('HOOK', 'session-init: host reported no user-submitted text; not storing a prompt', {
        sessionId,
      });
      return { continue: true, suppressOutput: true };
    }

    // Qwen's continuation and ToolResult sends leave `submitted_prompt` out
    // entirely rather than sending it empty, so the field arrives absent
    // (`undefined`) and the fallback below stores `[media prompt]` once per
    // tool round of an agent loop (#4215). The absence is only safe to read as
    // "not a user turn" on Qwen, which is why this is host-scoped: Claude Code
    // sends no field on the same command, and an empty prompt there is a real
    // image-only submission (#928).
    if (
      submittedPrompt === undefined &&
      !rawPrompt?.trim() &&
      isQwenTranscriptPath(input.transcriptPath)
    ) {
      logger.debug('HOOK', 'session-init: Qwen send carried no submitted_prompt and no prompt text; not storing a prompt', {
        sessionId,
      });
      return { continue: true, suppressOutput: true };
    }

    // When the host does supply it, `submittedPrompt` outranks `prompt`: it is
    // the text the human submitted, where `prompt` may be a tool result or a
    // hook send that merely reuses this event.
    const effectivePrompt = submittedPrompt ?? rawPrompt;
    const prompt = (!effectivePrompt || !effectivePrompt.trim()) ? '[media prompt]' : effectivePrompt;

    const projectContext = getProjectContext(cwd);
    const project = projectContext.primary;
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
          // Not thrown for recordSessionPrompt either: a rejection that does
          // not pass would stop the transcript watcher on this turn for good
          // (see SessionPromptNotRecordedError).
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
      if (requireRecordedPrompt) throw new SessionPromptNotRecordedError('budget_exhausted');
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
        // Where `project` was resolved from and how, so the worker can record
        // the session's checkout even if it never reports an observation.
        cwd,
        projectKeySource: projectContext.keySource,
      },
      workerSessionInitOptions(platformSource, initTimeoutMs),
    );

    if (dependencies.isWorkerFallback(initResult)) {
      if (requireRecordedPrompt) {
        throw new SessionPromptNotRecordedError('reason' in initResult ? initResult.reason : 'worker_fallback');
      }
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
          // Every key this checkout reads, so memory it stored before a re-key
          // (slug, environment, marker) is found too (gate P2-5).
          { q: prompt, project, projects: projectContext.allProjects, limit, platformSource },
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
