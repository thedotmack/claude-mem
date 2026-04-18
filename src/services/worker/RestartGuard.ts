/**
 * RestartGuard: Time-windowed restart counter for session generators.
 *
 * Replaces the flat consecutiveRestarts counter with a windowed approach:
 * - Only counts restarts within the last RESTART_WINDOW_MS (60 seconds)
 * - Higher raw cap (10) to accommodate legitimate long sessions
 * - Resets after RESTART_DECAY_MS (5 minutes) of successful processing
 *
 * Shared between worker-service.ts and SessionRoutes.ts to prevent
 * inconsistent restart guard logic.
 */

import type { ActiveSession } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/** Only count restarts within this window */
const RESTART_WINDOW_MS = 60_000; // 60 seconds

/** Reset counter after this much successful processing */
const RESTART_DECAY_MS = 5 * 60_000; // 5 minutes

/** Maximum restarts allowed within the window */
const MAX_WINDOWED_RESTARTS = 10;

/**
 * Record a restart attempt and check whether the session has exceeded the limit.
 *
 * @returns true if the restart is allowed, false if it should be blocked
 */
export function recordRestartAndCheckAllowed(session: ActiveSession, logContext: string): boolean {
  const now = Date.now();

  // Initialize restartTimestamps if missing (backward compat)
  if (!session.restartTimestamps) {
    session.restartTimestamps = [];
  }

  // Add current restart timestamp
  session.restartTimestamps.push(now);

  // Prune timestamps outside the window
  session.restartTimestamps = session.restartTimestamps.filter(
    ts => (now - ts) < RESTART_WINDOW_MS
  );

  // Also maintain the legacy counter for logging
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  const restartsInWindow = session.restartTimestamps.length;

  if (restartsInWindow > MAX_WINDOWED_RESTARTS) {
    logger.error('SYSTEM', `${logContext}: Exceeded max windowed restarts (${restartsInWindow}/${MAX_WINDOWED_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s)`, {
      sessionId: session.sessionDbId,
      restartsInWindow,
      maxRestarts: MAX_WINDOWED_RESTARTS,
      windowMs: RESTART_WINDOW_MS
    });
    return false;
  }

  return true;
}

/**
 * Reset the restart counter after successful processing.
 * Called when a session completes with no pending work, or after
 * sustained successful processing (decay).
 */
export function resetRestartCounter(session: ActiveSession): void {
  session.consecutiveRestarts = 0;
  session.restartTimestamps = [];
}

/**
 * Apply time decay: if enough time has passed since the last restart,
 * clear the restart history. Call this periodically during successful processing.
 */
export function applyRestartDecay(session: ActiveSession): void {
  if (!session.restartTimestamps || session.restartTimestamps.length === 0) return;

  const now = Date.now();
  const mostRecentRestart = Math.max(...session.restartTimestamps);

  if (now - mostRecentRestart > RESTART_DECAY_MS) {
    logger.debug('SYSTEM', 'Restart counter decayed after sustained success', {
      sessionId: session.sessionDbId,
      previousRestarts: session.restartTimestamps.length,
      decayMs: RESTART_DECAY_MS
    });
    resetRestartCounter(session);
  }
}
