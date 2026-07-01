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
import { isServerClientError } from '../../services/hooks/server-client.js';

async function dispatchToWorker(
  input: NormalizedHookInput,
  platformSource: string,
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

    const runtime = resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. `runtime-selector.selectRuntime()` continues to accept the legacy
    // `'server-beta'` literal in settings.json and normalizes it to `'server'`.
    if (runtime.runtime === 'server') {
      try {
        await runtime.client.recordEvent({
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
          },
        });
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

    return dispatchToWorker(input, platformSource);
  },
};
