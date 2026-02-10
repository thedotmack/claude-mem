/**
 * Session Complete Handler - Stop (Phase 2)
 *
 * Completes the session after summarize has been queued.
 * This removes the session from the active sessions map, allowing
 * the orphan reaper to clean up any remaining subprocess.
 *
 * Fixes Issue #842: Orphan reaper starts but never reaps because
 * sessions stay in the active sessions map forever.
 *
 * Issue #987: Omit `continue` field from Stop hook responses to prevent
 * Claude Code from interpreting it as "continue the conversation."
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, buildWorkerUrl } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

export const sessionCompleteHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    await ensureWorkerRunning();

    const { sessionId } = input;
    const port = getWorkerPort();

    if (!sessionId) {
      logger.warn('HOOK', 'session-complete: Missing sessionId, skipping');
      return { suppressOutput: true };
    }

    logger.info('HOOK', '→ session-complete: Removing session from active map', {
      workerPort: port,
      contentSessionId: sessionId
    });

    try {
      // Call the session complete endpoint by contentSessionId
      const response = await fetch(buildWorkerUrl('/api/sessions/complete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId
        })
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('HOOK', 'session-complete: Failed to complete session', {
          status: response.status,
          body: text
        });
      } else {
        logger.info('HOOK', 'Session completed successfully', { contentSessionId: sessionId });
      }
    } catch (error) {
      // Log but don't fail - session may already be gone
      logger.warn('HOOK', 'session-complete: Error completing session', {
        error: (error as Error).message
      });
    }

    return { suppressOutput: true };
  }
};
