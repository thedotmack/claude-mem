// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import { isServerClientError, type ServerRecordEventRequest } from '../../services/hooks/server-client.js';
import { extractLastMessage, countTranscriptLines } from '../../shared/transcript-parser.js';

const ADVISOR_TOOL_NAME = 'advisor';

/**
 * The `advisor` tool takes no arguments — it forwards the entire conversation
 * transcript to a stronger model and returns advice. `tool_input` is
 * therefore empty and doesn't tell us what context was sent. Rather than
 * duplicating the whole transcript into the database, capture a lightweight
 * pointer (transcript path + how many lines existed at call time) plus the
 * last user message for a quick preview.
 */
function extractAdvisorContext(input: NormalizedHookInput): {
  lastUserMessage?: string;
  transcriptPath?: string;
  transcriptLineCount?: number;
} | undefined {
  if (input.toolName !== ADVISOR_TOOL_NAME) {
    return undefined;
  }

  const transcriptPath = input.transcriptPath;
  if (!transcriptPath) {
    return { lastUserMessage: undefined, transcriptPath: undefined, transcriptLineCount: undefined };
  }

  return {
    lastUserMessage: extractLastMessage(transcriptPath, 'user', true) || undefined,
    transcriptPath,
    transcriptLineCount: countTranscriptLines(transcriptPath),
  };
}

async function dispatchToWorker(
  input: NormalizedHookInput,
  platformSource: string,
  advisorContext: ReturnType<typeof extractAdvisorContext>,
): Promise<HookResult> {
  const result = await executeWithWorkerFallback<{ status?: string }>(
    '/api/sessions/observations',
    'POST',
    {
      contentSessionId: input.sessionId,
      platformSource,
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      cwd: input.cwd,
      agentId: input.agentId,
      agentType: input.agentType,
      ...advisorContext,
    },
  );

  if (isWorkerFallback(result)) {
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  }

  logger.debug('HOOK', 'Observation sent successfully via worker', { toolName: input.toolName });
  return { continue: true, suppressOutput: true };
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    const advisorContext = extractAdvisorContext(input);

    const runtime = resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. `runtime-selector.selectRuntime()` continues to accept the legacy
    // `'server-beta'` literal in settings.json and normalizes it to `'server'`.
    if (runtime.runtime === 'server') {
      const event: ServerRecordEventRequest = {
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        platformSource,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
          ...advisorContext,
        },
      };
      try {
        await runtime.client.recordEvent(event);
        logger.debug('HOOK', 'Observation sent successfully via server', { toolName });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    return dispatchToWorker(input, platformSource, advisorContext);
  },
};
