/**
 * Time-windowed restart guard.
 * Prevents tight-loop restarts (bug) while allowing legitimate occasional restarts
 * over long sessions. Replaces the flat consecutiveRestarts counter that stranded
 * pending messages after just 3 restarts over any timeframe (#2053).
 *
 * TWO INDEPENDENT TRIPS:
 * 1. Sliding window: more than MAX_WINDOWED_RESTARTS within RESTART_WINDOW_MS.
 *    Catches genuinely tight loops (e.g. crash every <6s).
 * 2. Consecutive failures: more than MAX_CONSECUTIVE_FAILURES restarts with
 *    NO successful processing in between. Catches dead sessions that
 *    fail-restart-fail-restart on a slow exponential backoff cadence
 *    (e.g. 8s backoff cap + spawn failures = restartsInWindow stays under
 *    the windowed cap forever, but the session is clearly dead).
 */

const RESTART_WINDOW_MS = 60_000;      // Only count restarts within last 60 seconds
const MAX_WINDOWED_RESTARTS = 10;      // 10 restarts in 60s = runaway loop
const MAX_CONSECUTIVE_FAILURES = 5;    // 5 restarts with no success in between = session is dead
const DECAY_AFTER_SUCCESS_MS = 5 * 60_000; // Clear history after 5min of uninterrupted success

export class RestartGuard {
  private restartTimestamps: number[] = [];
  private lastSuccessfulProcessing: number | null = null;
  private consecutiveFailures: number = 0;

  /**
   * Record a restart and check if the guard should trip.
   * @returns true if the restart is ALLOWED, false if it should be BLOCKED
   */
  recordRestart(): boolean {
    const now = Date.now();

    // Decay: clear history only after real success + 5min of uninterrupted success
    if (this.lastSuccessfulProcessing !== null
        && now - this.lastSuccessfulProcessing >= DECAY_AFTER_SUCCESS_MS) {
      this.restartTimestamps = [];
      this.lastSuccessfulProcessing = null;
    }

    // Prune old timestamps outside the window
    this.restartTimestamps = this.restartTimestamps.filter(
      ts => now - ts < RESTART_WINDOW_MS
    );

    // Record this restart
    this.restartTimestamps.push(now);
    this.consecutiveFailures += 1;

    // Trip if EITHER guard exceeds its limit:
    //   - Sliding window cap (tight loops)
    //   - Consecutive failures with no successful work (dead session, e.g. spawn always fails)
    const withinWindowedCap = this.restartTimestamps.length <= MAX_WINDOWED_RESTARTS;
    const withinConsecutiveCap = this.consecutiveFailures <= MAX_CONSECUTIVE_FAILURES;
    return withinWindowedCap && withinConsecutiveCap;
  }

  /**
   * Call when a message is successfully processed to update the success timestamp.
   * Resets the consecutive-failure counter (real progress was made).
   */
  recordSuccess(): void {
    this.lastSuccessfulProcessing = Date.now();
    this.consecutiveFailures = 0;
  }

  /**
   * Get the number of restarts in the current window (for logging).
   */
  get restartsInWindow(): number {
    const now = Date.now();
    return this.restartTimestamps.filter(ts => now - ts < RESTART_WINDOW_MS).length;
  }

  /**
   * Get the window size in ms (for logging).
   */
  get windowMs(): number {
    return RESTART_WINDOW_MS;
  }

  /**
   * Get the max allowed restarts (for logging).
   */
  get maxRestarts(): number {
    return MAX_WINDOWED_RESTARTS;
  }

  /**
   * Get consecutive failures since last successful processing (for logging).
   */
  get consecutiveFailuresSinceSuccess(): number {
    return this.consecutiveFailures;
  }

  /**
   * Get the max allowed consecutive failures (for logging).
   */
  get maxConsecutiveFailures(): number {
    return MAX_CONSECUTIVE_FAILURES;
  }
}
