/**
 * Summarize Handler - Stop
 *
 * Runs in the Stop hook. Fire-and-forget: enqueue the summarize request
 * and return immediately. The worker processes the summary in the background.
 * SessionEnd hook handles session completion independently.
 *
 * The worker's SessionCompletionHandler defers session deletion when pending
 * work exists (e.g. in-flight summarize), so summaries are not lost.
 *
 * Previous versions (v10.7.0-v11.0.1) polled /api/sessions/status for up to
 * 110 seconds waiting for queueLength === 0. When the worker pool (capped at 2)
 * was saturated by concurrent sessions, this blocked the CLI for the full timeout
 * on every assistant turn and created a positive feedback loop.
 * See: https://github.com/thedotmack/claude-mem/issues/1601
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip summary gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    // Validate required fields before processing
    if (!transcriptPath) {
      // No transcript available - skip summary gracefully (not an error)
      logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    let lastAssistantMessage = '';
    try {
      lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
    } catch (err) {
      logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Skip summary if transcript has no assistant message (prevents repeated
    // empty summarize requests that pollute logs — upstream bug)
    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message in transcript - skipping summary', {
        sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // Fire-and-forget: enqueue summarize request, worker processes in background.
    // The worker's SessionCompletionHandler defers session deletion when pending
    // work exists, so the summary will complete before the agent is killed.
    // SessionEnd hook calls /api/sessions/complete independently.
    const response = await workerHttpRequest('/api/sessions/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage
      }),
      timeoutMs: SUMMARIZE_TIMEOUT_MS
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      logger.warn('HOOK', `Stop hook: summarize request failed (${response.status}): ${text}`);
    } else {
      logger.info('HOOK', 'Summary request enqueued', { contentSessionId: sessionId });
    }

    return { continue: true, suppressOutput: true };
  }
};
