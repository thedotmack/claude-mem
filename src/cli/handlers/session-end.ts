/**
 * Session End Handler - SessionEnd
 *
 * Called when Claude Code session closes.
 * Triggers cleanup of SDK agent subprocess to prevent orphan accumulation.
 * This was previously removed (Dec 27, 2025 #32198) but orphans still occur.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;

    // SessionEnd can fire even if session was never initialized
    // (e.g., Claude Code opened but no prompt submitted)
    if (!sessionId) {
      return { continue: true, suppressOutput: true };
    }

    const port = getWorkerPort();

    logger.info('HOOK', 'SessionEnd: Cleaning up session', { contentSessionId: sessionId });

    try {
      // Call cleanup endpoint - worker handles subprocess termination
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: sessionId })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
      });

      if (!response.ok) {
        // Worker might not be running or session might not exist
        // This is expected in some cases (e.g., session never initialized)
        logger.debug('HOOK', 'Session cleanup returned non-OK status', {
          status: response.status,
          contentSessionId: sessionId
        });
      } else {
        logger.info('HOOK', 'Session cleaned up successfully', { contentSessionId: sessionId });
      }
    } catch (error) {
      // Worker not running - nothing to clean up
      logger.debug('HOOK', 'Worker not reachable for cleanup', {
        contentSessionId: sessionId,
        error: String(error)
      });
    }

    return { continue: true, suppressOutput: true };
  }
};
