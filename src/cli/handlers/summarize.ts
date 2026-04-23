/**
 * Summarize Handler - Stop
 *
 * Plan 05 Phase 3 (PATHFINDER-2026-04-22): the 120-second client-side polling
 * loop is replaced by a single POST to `/api/session/end`, which the worker
 * holds open until the summary-stored event fires. One request, one response,
 * no polling on either side.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

interface SessionEndResponse {
  ok: boolean;
  messageId?: number;
  reason?: string;
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Skip summaries in subagent context — subagents do not own the session summary.
    // Gate on agentId only: that field is present exclusively for Task-spawned subagents.
    // agentType alone (no agentId) indicates `--agent`-started main sessions, which still
    // own their summary. Do this BEFORE the worker call so a subagent Stop hook
    // does not bootstrap the worker.
    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    // Validate required fields before processing
    if (!sessionId) {
      logger.warn('HOOK', 'summarize: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
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

    logger.debug('HOOK', 'Summary request queued, awaiting blocking session-end response');

    // 2. Plan 05 Phase 3 — single blocking POST. Server holds the connection
    //    open until the summary-stored event fires (Plan 03 Phase 2 emitter)
    //    or its server-side timeout elapses. No polling on this side.
    const endResult = await executeWithWorkerFallback<SessionEndResponse>(
      '/api/session/end',
      'POST',
      { sessionId },
    );
    if (isWorkerFallback(endResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    if (endResult?.ok) {
      logger.info('HOOK', 'Summary stored', {
        sessionId,
        messageId: endResult.messageId,
      });
    } else {
      // 504 from server — agent didn't store a summary inside the server-side
      // window. Logged so the silent-failure path (#1633) stays visible.
      logger.warn('HOOK', 'Session-end did not observe a stored summary', {
        sessionId,
        reason: endResult?.reason,
      });
    }

    // 3. Complete the session — clean up active sessions map.
    //    Runs here in Stop (120s timeout) instead of SessionEnd (1.5s cap)
    //    so it reliably fires after summary work is done.
    const completeResult = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/complete',
      'POST',
      { contentSessionId: sessionId },
    );
    if (isWorkerFallback(completeResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    logger.info('HOOK', 'Session completed in Stop hook', { contentSessionId: sessionId });

    return { continue: true, suppressOutput: true };
  },
};
