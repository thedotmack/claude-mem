/**
 * Time-windowed restart guard.
 * Prevents tight-loop restarts (bug) while allowing legitimate occasional restarts
 * over long sessions. Replaces the flat consecutiveRestarts counter that stranded
 * pending messages after just 3 restarts over any timeframe (#2053).
 */

const RESTART_WINDOW_MS = 60_000;      // Only count restarts within last 60 seconds
const MAX_WINDOWED_RESTARTS = 10;      // 10 restarts in 60s = runaway loop
const DECAY_AFTER_SUCCESS_MS = 5 * 60_000; // Clear history after 5min of uninterrupted success

export class RestartGuard {
  private restartTimestamps: number[] = [];
  private lastSuccessfulProcessing: number | null = null;

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

    // Check if we've exceeded the cap within the window
    return this.restartTimestamps.length <= MAX_WINDOWED_RESTARTS;
  }

  /**
   * Call when a message is successfully processed to update the success timestamp.
   */
  recordSuccess(): void {
    this.lastSuccessfulProcessing = Date.now();
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
}
