/**
 * Time-windowed restart guard.
 * Prevents tight-loop restarts (bug) while allowing legitimate occasional restarts
 * over long sessions. Replaces the flat consecutiveRestarts counter that stranded
 * pending messages after just 3 restarts over any timeframe (#2053).
 *
 * Additional guards (Phase 2 of windows-max-plan-drain-fix):
 *   - Decay of windowed history only fires after N consecutive successes, so a
 *     single fluky success cannot clear the runaway-loop detector.
 *   - Absolute lifetime cap: once total restarts cross the cap, the guard trips
 *     permanently and cannot be reset by later successes.
 */

const RESTART_WINDOW_MS = 60_000;      // Only count restarts within last 60 seconds
const MAX_WINDOWED_RESTARTS = 10;      // 10 restarts in 60s = runaway loop
const DECAY_AFTER_SUCCESS_MS = 5 * 60_000; // Clear history after 5min of uninterrupted success
const REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY = 5;
const ABSOLUTE_LIFETIME_RESTART_CAP = 50;

export class RestartGuard {
  private restartTimestamps: number[] = [];
  private lastSuccessfulProcessing: number | null = null;
  private consecutiveSuccessCount = 0;
  private totalRestartsAllTime = 0;
  private decayEligible = false;

  /**
   * Record a restart and check if the guard should trip.
   * @returns true if the restart is ALLOWED, false if it should be BLOCKED
   */
  recordRestart(): boolean {
    this.totalRestartsAllTime += 1;
    this.consecutiveSuccessCount = 0; // streak broken by any restart

    // Terminal: lifetime cap reached — never resets, even if successes follow.
    if (this.totalRestartsAllTime > ABSOLUTE_LIFETIME_RESTART_CAP) {
      return false;
    }

    const now = Date.now();

    // Decay: only fires if we accumulated the required consecutive successes
    // AND 5min has elapsed since the last success. One-off successes cannot
    // clear the windowed-restart history.
    if (this.decayEligible
        && this.lastSuccessfulProcessing !== null
        && now - this.lastSuccessfulProcessing >= DECAY_AFTER_SUCCESS_MS) {
      this.restartTimestamps = [];
      this.lastSuccessfulProcessing = null;
      this.decayEligible = false;
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
   * Requires REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY consecutive calls before
   * the restart-window decay path can fire.
   */
  recordSuccess(): void {
    this.consecutiveSuccessCount += 1;
    this.lastSuccessfulProcessing = Date.now();
    if (this.consecutiveSuccessCount >= REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY) {
      this.decayEligible = true;
    }
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
   * Total restarts counted for the lifetime of this guard (for logging).
   * Never decreases; compared against `lifetimeCap` to decide terminal trip.
   */
  get totalRestarts(): number {
    return this.totalRestartsAllTime;
  }

  /**
   * Absolute lifetime restart cap (for logging).
   */
  get lifetimeCap(): number {
    return ABSOLUTE_LIFETIME_RESTART_CAP;
  }
}
