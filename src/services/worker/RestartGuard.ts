
const RESTART_WINDOW_MS = 60_000;      
const MAX_WINDOWED_RESTARTS = 10;      
const MAX_CONSECUTIVE_FAILURES = 5;    
const DECAY_AFTER_SUCCESS_MS = 5 * 60_000; 

export class RestartGuard {
  private restartTimestamps: number[] = [];
  private lastSuccessfulProcessing: number | null = null;
  private consecutiveFailures: number = 0;

  recordRestart(): boolean {
    const now = Date.now();

    if (this.lastSuccessfulProcessing !== null
        && now - this.lastSuccessfulProcessing >= DECAY_AFTER_SUCCESS_MS) {
      this.restartTimestamps = [];
      this.lastSuccessfulProcessing = null;
    }

    this.restartTimestamps = this.restartTimestamps.filter(
      ts => now - ts < RESTART_WINDOW_MS
    );

    this.restartTimestamps.push(now);
    this.consecutiveFailures += 1;

    const withinWindowedCap = this.restartTimestamps.length <= MAX_WINDOWED_RESTARTS;
    const withinConsecutiveCap = this.consecutiveFailures <= MAX_CONSECUTIVE_FAILURES;
    return withinWindowedCap && withinConsecutiveCap;
  }

  recordSuccess(): void {
    this.lastSuccessfulProcessing = Date.now();
    this.consecutiveFailures = 0;
  }

  get restartsInWindow(): number {
    const now = Date.now();
    return this.restartTimestamps.filter(ts => now - ts < RESTART_WINDOW_MS).length;
  }

  get windowMs(): number {
    return RESTART_WINDOW_MS;
  }

  get maxRestarts(): number {
    return MAX_WINDOWED_RESTARTS;
  }

  get consecutiveFailuresSinceSuccess(): number {
    return this.consecutiveFailures;
  }

  get maxConsecutiveFailures(): number {
    return MAX_CONSECUTIVE_FAILURES;
  }
}
