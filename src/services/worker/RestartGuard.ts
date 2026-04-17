/**
 * Windowed Restart Guard
 *
 * Replaces the flat `consecutiveRestarts` counter with a time-windowed
 * approach.  Only restarts within a recent window are counted, so a
 * long-running session that occasionally restarts will never hit the
 * cap, while a tight crash-loop (persistent FK error, missing session
 * ID, etc.) will trip the guard within seconds.
 *
 * Both `worker-service.ts` and `SessionRoutes.ts` share this module so
 * the logic stays in one place.
 *
 * Issue: Generator restart guard strands pending messages with no recovery
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Time window (ms) in which restarts are counted.  Restarts older than
 *  this are pruned and no longer contribute to the count. */
export const RESTART_WINDOW_MS = 60_000; // 60 seconds

/** Maximum restarts allowed inside the window before tripping the guard.
 *  "5 restarts in 60 s" catches tight loops while allowing healthy
 *  sessions to restart a handful of times per hour without issue. */
export const MAX_RESTARTS_IN_WINDOW = 5;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Minimal shape that any object must satisfy to participate in windowed
 * restart tracking.  `ActiveSession` satisfies this after the type
 * update.
 */
export interface RestartTracker {
  restartTimestamps: number[];
  consecutiveRestarts: number;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Record a restart attempt and decide whether it should be allowed.
 *
 * 1. Prune timestamps older than `RESTART_WINDOW_MS`.
 * 2. Push the current timestamp.
 * 3. Sync `consecutiveRestarts` (kept for backward-compat logging).
 * 4. Return `true` if the restart is within budget, `false` to block.
 *
 * @param tracker  Session (or test stub) that holds the timestamps.
 * @param now      Current epoch ms — injectable for deterministic tests.
 */
export function recordRestart(
  tracker: RestartTracker,
  now: number = Date.now(),
): boolean {
  // Prune stale entries
  tracker.restartTimestamps = tracker.restartTimestamps.filter(
    (ts) => now - ts < RESTART_WINDOW_MS,
  );

  // Record this restart
  tracker.restartTimestamps.push(now);

  // Keep legacy field in sync for log output / backcompat
  tracker.consecutiveRestarts = tracker.restartTimestamps.length;

  return tracker.restartTimestamps.length <= MAX_RESTARTS_IN_WINDOW;
}

/**
 * Reset the tracker — called on clean completion (no pending work).
 */
export function resetRestarts(tracker: RestartTracker): void {
  tracker.restartTimestamps = [];
  tracker.consecutiveRestarts = 0;
}

/**
 * Return the number of restarts still inside the current window.
 * Useful for logging / diagnostics without mutating the tracker.
 */
export function getRecentRestartCount(
  tracker: RestartTracker,
  now: number = Date.now(),
): number {
  return tracker.restartTimestamps.filter(
    (ts) => now - ts < RESTART_WINDOW_MS,
  ).length;
}
