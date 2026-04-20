/**
 * Session Complete Handler - Stop (Phase 2)
 *
 * Completes the session after summarize has been queued.
 * This removes the session from the active sessions map, allowing
 * the orphan reaper to clean up any remaining subprocess.
 *
 * Fixes Issue #842: Orphan reaper starts but never reaps because
 * sessions stay in the active sessions map forever.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

async function sendSessionCompleteRequest(sessionId: string, platformSource: string): Promise<void> {
  const response = await workerHttpRequest('/api/sessions/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentSessionId: sessionId, platformSource })
  });

  if (!response.ok) {
    const text = await response.text();
    logger.warn('HOOK', 'session-complete: Failed to complete session', { status: response.status, body: text });
  } else {
    logger.info('HOOK', 'Session completed successfully', { contentSessionId: sessionId });
  }
}

export const sessionCompleteHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available — skip session completion gracefully
      return { continue: true, suppressOutput: true };
    }

    const { sessionId } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!sessionId) {
      logger.warn('HOOK', 'session-complete: Missing sessionId, skipping');
      return { continue: true, suppressOutput: true };
    }

    logger.info('HOOK', '→ session-complete: Removing session from active map', {
      contentSessionId: sessionId
    });

    try {
      await sendSessionCompleteRequest(sessionId, platformSource);
    } catch (error) {
      // Log but don't fail - session may already be gone
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('HOOK', 'session-complete: Error completing session', {
        error: errorMessage
      });
    }

    return { continue: true, suppressOutput: true };
  }
};
