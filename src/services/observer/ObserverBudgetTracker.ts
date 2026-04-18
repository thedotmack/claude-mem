/**
 * ObserverBudgetTracker
 *
 * Addresses Bug #1938: Observer background sessions burn excessive tokens with no budget cap.
 *
 * Provides:
 * 1. Daily token budget tracking (resets at midnight)
 * 2. Throttling between observer runs (configurable minimum interval)
 * 3. Budget check before processing each observation
 *
 * All state is in-memory (resets on worker restart, which is acceptable since
 * it means a restart gives a fresh daily budget).
 */

import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export class ObserverBudgetTracker {
  private static instance: ObserverBudgetTracker | null = null;

  /** Total tokens consumed today */
  private tokensConsumedToday: number = 0;

  /** Date string (YYYY-MM-DD) for the current budget period */
  private currentBudgetDay: string;

  /** Timestamp of the last observation processing */
  private lastObservationTimestamp: number = 0;

  /** Number of observations skipped due to budget exhaustion (for logging) */
  private skippedDueToBudget: number = 0;

  /** Number of observations skipped due to throttling (for logging) */
  private skippedDueToThrottle: number = 0;

  private constructor() {
    this.currentBudgetDay = this.getTodayString();
  }

  static getInstance(): ObserverBudgetTracker {
    if (!ObserverBudgetTracker.instance) {
      ObserverBudgetTracker.instance = new ObserverBudgetTracker();
    }
    return ObserverBudgetTracker.instance;
  }

  /**
   * Reset the singleton (useful for testing).
   */
  static resetInstance(): void {
    ObserverBudgetTracker.instance = null;
  }

  /**
   * Check whether an observation should be processed, enforcing both
   * the daily token budget and the throttle interval.
   *
   * Returns true if the observation is allowed, false if it should be skipped.
   */
  canProcessObservation(): boolean {
    this.maybeResetDailyBudget();

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxTokensPerDay = parseInt(settings.CLAUDE_MEM_OBSERVER_MAX_TOKENS_PER_DAY, 10) || 100_000;
    const throttleMs = parseInt(settings.CLAUDE_MEM_OBSERVER_THROTTLE_MS, 10) || 5000;

    // Check throttle
    const now = Date.now();
    const timeSinceLastObservation = now - this.lastObservationTimestamp;
    if (this.lastObservationTimestamp > 0 && timeSinceLastObservation < throttleMs) {
      this.skippedDueToThrottle++;
      if (this.skippedDueToThrottle % 50 === 1) {
        logger.debug('OBSERVER', 'Observation throttled', {
          timeSinceLastMs: timeSinceLastObservation,
          throttleMs,
          totalSkippedThrottle: this.skippedDueToThrottle,
        });
      }
      return false;
    }

    // Check budget
    if (this.tokensConsumedToday >= maxTokensPerDay) {
      this.skippedDueToBudget++;
      if (this.skippedDueToBudget === 1 || this.skippedDueToBudget % 100 === 0) {
        logger.warn('OBSERVER', 'Daily token budget exceeded, skipping observation', {
          tokensConsumedToday: this.tokensConsumedToday,
          maxTokensPerDay,
          skippedCount: this.skippedDueToBudget,
          budgetDay: this.currentBudgetDay,
        });
      }
      return false;
    }

    return true;
  }

  /**
   * Record that an observation was processed and how many tokens it consumed.
   * Call this after the observation has been successfully processed.
   */
  recordTokensUsed(tokenCount: number): void {
    this.maybeResetDailyBudget();
    this.tokensConsumedToday += tokenCount;
    this.lastObservationTimestamp = Date.now();

    logger.debug('OBSERVER', 'Token usage recorded', {
      tokensUsed: tokenCount,
      tokensConsumedToday: this.tokensConsumedToday,
      budgetDay: this.currentBudgetDay,
    });
  }

  /**
   * Mark that an observation was processed (updates the throttle timestamp)
   * even when no token count is available yet (e.g. for queuing).
   */
  markObservationProcessed(): void {
    this.lastObservationTimestamp = Date.now();
  }

  /**
   * Get current budget status for health/status endpoints.
   */
  getBudgetStatus(): {
    tokensConsumedToday: number;
    maxTokensPerDay: number;
    budgetDay: string;
    skippedDueToBudget: number;
    skippedDueToThrottle: number;
    budgetExhausted: boolean;
  } {
    this.maybeResetDailyBudget();
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxTokensPerDay = parseInt(settings.CLAUDE_MEM_OBSERVER_MAX_TOKENS_PER_DAY, 10) || 100_000;

    return {
      tokensConsumedToday: this.tokensConsumedToday,
      maxTokensPerDay,
      budgetDay: this.currentBudgetDay,
      skippedDueToBudget: this.skippedDueToBudget,
      skippedDueToThrottle: this.skippedDueToThrottle,
      budgetExhausted: this.tokensConsumedToday >= maxTokensPerDay,
    };
  }

  /**
   * Reset daily budget if the day has changed (midnight rollover).
   */
  private maybeResetDailyBudget(): void {
    const today = this.getTodayString();
    if (today !== this.currentBudgetDay) {
      logger.info('OBSERVER', 'Daily token budget reset', {
        previousDay: this.currentBudgetDay,
        previousTokens: this.tokensConsumedToday,
        previousSkippedBudget: this.skippedDueToBudget,
        previousSkippedThrottle: this.skippedDueToThrottle,
      });
      this.currentBudgetDay = today;
      this.tokensConsumedToday = 0;
      this.skippedDueToBudget = 0;
      this.skippedDueToThrottle = 0;
    }
  }

  private getTodayString(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
