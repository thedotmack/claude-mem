
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.cwd && !shouldTrackProject(input.cwd)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.stopHookActive === true) {
      logger.debug('HOOK', 'Skipping summary: Codex Stop hook re-entry detected', {
        sessionId: input.sessionId,
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'summarize: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    let lastAssistantMessage = '';

    if (input.lastAssistantMessage !== undefined) {
      lastAssistantMessage = stripMemoryTagsFromPrompt(input.lastAssistantMessage);
    } else {
      if (!transcriptPath) {
        logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      try {
        lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
        lastAssistantMessage = stripMemoryTagsFromPrompt(lastAssistantMessage);
      } catch (err) {
        logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    }

    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message available - skipping summary', {
        sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    const platformSource = normalizePlatformSource(input.platform);

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      try {
        // Resolve the server_session_id idempotently. /v1/sessions/start is
        // idempotent on (projectId, externalSessionId) and returns the
        // existing row when present.
        const startResult = await runtime.client.startSession({
          projectId: runtime.projectId,
          externalSessionId: sessionId,
          contentSessionId: sessionId,
          platformSource,
        });
        const serverSessionId = startResult.session.id;
        // Record the last assistant message as an event before closing the
        // session so it lands in the generation pipeline.
        await runtime.client.recordEvent({
          projectId: runtime.projectId,
          serverSessionId,
          contentSessionId: sessionId,
          sourceType: 'hook',
          eventType: 'assistant_message',
          occurredAtEpoch: Date.now(),
          payload: {
            last_assistant_message: lastAssistantMessage,
            platformSource,
          },
        });
        await runtime.client.endSession({ sessionId: serverSessionId });
        logger.debug('HOOK', 'Summary request queued via server-beta');
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/end',
          });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server beta summarize failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    const queueResult = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/summarize',
      'POST',
      {
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage,
        platformSource,
      },
    );
    if (isWorkerFallback(queueResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Summary request queued, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
