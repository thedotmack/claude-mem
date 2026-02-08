/**
 * Thoughts Extract Handler - Stop (Phase 1.5)
 *
 * Extracts thinking blocks from the transcript and stores them via the worker API.
 * Runs AFTER summarize and BEFORE session-complete in the Stop hook chain.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { handleThoughtsExtraction } from '../../hooks/handlers/thoughts.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

export const thoughtsExtractHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, transcriptPath } = input;

    if (!transcriptPath) {
      logger.warn('HOOK', 'thoughts-extract: Missing transcriptPath, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!sessionId) {
      logger.warn('HOOK', 'thoughts-extract: Missing sessionId, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    try {
      // handleThoughtsExtraction extracts thinking blocks from the transcript
      // and sends them to POST /api/sessions/thoughts on the worker.
      // The worker endpoint resolves memorySessionId and project from contentSessionId.
      const result = await handleThoughtsExtraction({
        transcriptPath,
        sessionId,
        memorySessionId: '',
        project: '',
      });

      logger.info('HOOK', `thoughts-extract: Stored ${result.thoughtsStored} thoughts`, {
        contentSessionId: sessionId
      });
    } catch (error) {
      // Log but don't fail - thoughts extraction should never block session completion
      logger.warn('HOOK', 'thoughts-extract: Error extracting thoughts', {
        error: (error as Error).message
      });
    }

    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
