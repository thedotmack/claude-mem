/**
 * Summarize Handler - Stop
 *
 * Fire-and-forget: enqueue the summarize request with the worker and return
 * immediately so the Stop hook does not block the user's terminal. The worker
 * owns completion and session cleanup.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

const SUMMARIZE_TIMEOUT_MS = 5000;

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Skip summaries in subagent context — subagents do not own the session summary.
    // Gate on agentId only: that field is present exclusively for Task-spawned subagents.
    // agentType alone (no agentId) indicates `--agent`-started main sessions, which still
    // own their summary. Do this BEFORE ensureWorkerRunning() so a subagent Stop hook
    // does not bootstrap the worker.
    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

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

    const platformSource = normalizePlatformSource(input.platform);

    // 1. Queue summarize request — worker returns immediately with { status: 'queued' }
    let response: Response;
    try {
      response = await workerHttpRequest('/api/sessions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          last_assistant_message: lastAssistantMessage,
          platformSource
        }),
        timeoutMs: SUMMARIZE_TIMEOUT_MS
      });
    } catch (err) {
      // Network error, worker crash, or timeout — exit gracefully instead of
      // bubbling to hook runner which exits code 2 and blocks session exit (#1901)
      logger.warn('HOOK', `Stop hook: summarize request failed: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!response.ok) {
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request queued');

    return { continue: true, suppressOutput: true };
  }
};
