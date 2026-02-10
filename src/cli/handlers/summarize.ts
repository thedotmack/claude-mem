/**
 * Summarize Handler - Stop
 *
 * Extracted from summary-hook.ts - sends summary request to worker.
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 *
 * IMPORTANT (Issue #987): This handler runs during the Stop hook lifecycle.
 * The response must NOT contain content that Claude Code could interpret as
 * instructions to continue working. We use suppressOutput: true and omit
 * the `continue` field to prevent infinite session loops.
 *
 * Loop guard: If the Stop hook fires multiple times within a short window
 * for the same session, we skip the summarize request to break the loop.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout, buildWorkerUrl } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

/**
 * Loop detection guard (Issue #987).
 * Tracks recent Stop hook invocations per session to detect infinite loops.
 * If the Stop hook fires more than MAX_STOP_INVOCATIONS_PER_WINDOW times
 * within LOOP_DETECTION_WINDOW_MS, we skip summarize to break the cycle.
 */
const MAX_STOP_INVOCATIONS_PER_WINDOW = 3;
const LOOP_DETECTION_WINDOW_MS = 60_000; // 60 seconds

const recentStopInvocations = new Map<string, number[]>();

function isStopHookLooping(sessionId: string): boolean {
  const now = Date.now();
  const timestamps = recentStopInvocations.get(sessionId) ?? [];

  // Remove timestamps outside the window
  const recentTimestamps = timestamps.filter(t => now - t < LOOP_DETECTION_WINDOW_MS);
  recentTimestamps.push(now);

  recentStopInvocations.set(sessionId, recentTimestamps);

  return recentTimestamps.length > MAX_STOP_INVOCATIONS_PER_WINDOW;
}

/** Exported for testing */
export function _resetLoopDetection(): void {
  recentStopInvocations.clear();
}

/** Exported for testing */
export function _getRecentStopInvocations(): Map<string, number[]> {
  return recentStopInvocations;
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, transcriptPath } = input;

    // Loop detection guard (Issue #987): skip summarize if Stop hook is looping
    if (sessionId && isStopHookLooping(sessionId)) {
      logger.warn('HOOK', 'Stop hook loop detected — skipping summarize to break cycle', {
        sessionId,
        maxInvocations: MAX_STOP_INVOCATIONS_PER_WINDOW,
        windowMs: LOOP_DETECTION_WINDOW_MS
      });
      return { suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip summary gracefully
      return { suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const port = getWorkerPort();

    // Validate required fields before processing
    if (!transcriptPath) {
      logger.warn('HOOK', 'Missing transcriptPath in Stop hook input', { sessionId });
      return { suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      workerPort: port,
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // Send to worker - worker handles privacy check and database operations
    const response = await fetchWithTimeout(
      buildWorkerUrl('/api/sessions/summarize'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          last_assistant_message: lastAssistantMessage
        }),
      },
      SUMMARIZE_TIMEOUT_MS
    );

    if (!response.ok) {
      // Return minimal response on failure — no `continue` field to avoid
      // Claude Code interpreting this as "continue the conversation" (Issue #987)
      return { suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request sent successfully');

    // Issue #987: Omit `continue` field from Stop hook responses.
    // Returning `continue: true` in a Stop hook can cause Claude Code to
    // interpret the response as "continue the conversation," leading to
    // infinite session loops.
    return { suppressOutput: true };
  }
};
