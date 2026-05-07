
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';

type SummarySkipReason =
  | 'excluded_project'
  | 'stop_hook_reentry'
  | 'subagent_context'
  | 'missing_session_id'
  | 'missing_transcript'
  | 'extraction_failure'
  | 'no_assistant_message';

function summarySkipContext(
  input: NormalizedHookInput,
  reason: SummarySkipReason,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    reason,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    platform: input.platform,
    source: normalizePlatformSource(input.platform),
    ...extra,
  };
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.cwd && !shouldTrackProject(input.cwd)) {
      logger.debug('HOOK', 'Skipping summary', summarySkipContext(input, 'excluded_project', {
        cwd: input.cwd,
      }));
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.stopHookActive === true) {
      logger.debug('HOOK', 'Skipping summary', summarySkipContext(input, 'stop_hook_reentry'));
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary', summarySkipContext(input, 'subagent_context', {
        agentId: input.agentId,
        agentType: input.agentType
      }));
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'Skipping summary', summarySkipContext(input, 'missing_session_id'));
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    let lastAssistantMessage = '';

    if (input.lastAssistantMessage !== undefined) {
      lastAssistantMessage = stripMemoryTagsFromPrompt(input.lastAssistantMessage);
    } else {
      if (!transcriptPath) {
        logger.debug('HOOK', 'Skipping summary', summarySkipContext(input, 'missing_transcript'));
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      try {
        lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
        lastAssistantMessage = stripMemoryTagsFromPrompt(lastAssistantMessage);
      } catch (err) {
        logger.warn('HOOK', 'Skipping summary', summarySkipContext(input, 'extraction_failure', {
          error: err instanceof Error ? err.message : String(err),
        }));
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    }

    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'Skipping summary', summarySkipContext(input, 'no_assistant_message'));
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      sessionId,
      platform: input.platform,
      source: platformSource,
      hasLastAssistantMessage: !!lastAssistantMessage
    });

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
