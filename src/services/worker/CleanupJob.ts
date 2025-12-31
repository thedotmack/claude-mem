/**
 * CleanupJob: Scheduled memory cleanup operations
 *
 * Responsibility:
 * - Run periodic cleanup of low-value memories
 * - Clean up old access tracking records
 * - Maintain healthy database size
 * - Provide cleanup statistics and logging
 *
 * Core concept from Titans: Adaptive weight decay to manage finite capacity
 */

import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { ForgettingPolicy } from './ForgettingPolicy.js';
import { AccessTracker } from './AccessTracker.js';
import { checkpointManager } from '../batch/checkpoint.js';
import { createBatchJobState, type BatchJobState } from '../../types/batch-job.js';

/**
 * Cleanup job configuration
 */
export interface CleanupConfig {
  // Memory cleanup
  enableMemoryCleanup: boolean;
  memoryCleanupIntervalHours: number;    // How often to run cleanup
  memoryCleanupLimit: number;             // Max memories to clean per run
  memoryCleanupDryRun: boolean;           // If true, only report what would be cleaned

  // Access tracking cleanup
  enableAccessCleanup: boolean;
  accessCleanupOlderThanDays: number;     // Remove access records older than this

  // Importance score recalculation
  enableImportanceRecalc: boolean;
  importanceRecalcLimit: number;          // Max memories to recalculate per run
  importanceRecalcLookbackDays: number;   // How far back to look for recalculation
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CleanupConfig = {
  enableMemoryCleanup: false,           // Disabled by default for safety
  memoryCleanupIntervalHours: 24,       // Run daily
  memoryCleanupLimit: 100,
  memoryCleanupDryRun: true,            // Default to dry run for safety

  enableAccessCleanup: true,
  accessCleanupOlderThanDays: 90,

  enableImportanceRecalc: true,
  importanceRecalcLimit: 500,
  importanceRecalcLookbackDays: 180,    // 6 months lookback window
};

/**
 * Result of a cleanup job run
 */
export interface CleanupResult {
  timestamp: number;
  duration: number;  // milliseconds
  memoryCleanup: {
    enabled: boolean;
    evaluated: number;
    deleted: number;
    dryRun: boolean;
    candidates?: Array<{ id: number; title: string; reason: string }>;
  };
  accessCleanup: {
    enabled: boolean;
    deletedRecords: number;
  };
  importanceRecalc: {
    enabled: boolean;
    recalculated: number;
  };
}

/**
 * Manages scheduled cleanup operations for memory management
 *
 * This job should be run periodically (e.g., daily) to:
 * 1. Remove low-value memories that haven't been accessed
 * 2. Clean up old access tracking records
 * 3. Recalculate importance scores for accuracy
 */
export class CleanupJob {
  private config: CleanupConfig;
  private scheduledTimer: NodeJS.Timeout | null = null;
  private lastRun: CleanupResult | null = null;
  private currentJobId: string | null = null;

  constructor(private db: Database, config?: Partial<CleanupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a single cleanup pass
   */
  async run(): Promise<CleanupResult> {
    const startTime = Date.now();

    // Create and register job with checkpoint manager
    const jobState = createBatchJobState('cleanup', {
      options: {
        batchSize: this.config.memoryCleanupLimit,
        maxConcurrency: 1,
        timeoutMs: 300000,
        dryRun: this.config.memoryCleanupDryRun,
        skipOnError: true,
      },
      typeConfig: {
        retentionDays: this.config.accessCleanupOlderThanDays,
      },
    });
    this.currentJobId = jobState.jobId;
    checkpointManager.registerJob(jobState);
    checkpointManager.startAutoCheckpoint(jobState.jobId);

    logger.info('CleanupJob', 'Starting cleanup job', {
      jobId: jobState.jobId,
      config: this.config,
    });

    const result: CleanupResult = {
      timestamp: startTime,
      duration: 0,
      memoryCleanup: {
        enabled: this.config.enableMemoryCleanup,
        evaluated: 0,
        deleted: 0,
        dryRun: this.config.memoryCleanupDryRun,
      },
      accessCleanup: {
        enabled: this.config.enableAccessCleanup,
        deletedRecords: 0,
      },
      importanceRecalc: {
        enabled: this.config.enableImportanceRecalc,
        recalculated: 0,
      },
    };

    try {
      // Calculate total items for progress tracking
      const totalSteps =
        (this.config.enableMemoryCleanup ? 1 : 0) +
        (this.config.enableAccessCleanup ? 1 : 0) +
        (this.config.enableImportanceRecalc ? 1 : 0);

      checkpointManager.updateProgress(jobState.jobId, { totalItems: totalSteps });
      checkpointManager.updateStage(jobState.jobId, 'executing');

      let completedSteps = 0;

      // Step 1: Memory cleanup (if enabled)
      if (this.config.enableMemoryCleanup) {
        checkpointManager.updateProgress(jobState.jobId, {
          processedItems: completedSteps,
        });

        const memoryResult = await this.runMemoryCleanup();
        result.memoryCleanup.evaluated = memoryResult.evaluated;
        result.memoryCleanup.deleted = memoryResult.deleted;
        result.memoryCleanup.candidates = memoryResult.candidates;

        completedSteps++;
        checkpointManager.updateProgress(jobState.jobId, {
          processedItems: completedSteps,
          completedItems: completedSteps,
        });
      }

      // Step 2: Access tracking cleanup (if enabled)
      if (this.config.enableAccessCleanup) {
        const deletedRecords = await this.runAccessCleanup();
        result.accessCleanup.deletedRecords = deletedRecords;

        completedSteps++;
        checkpointManager.updateProgress(jobState.jobId, {
          processedItems: completedSteps,
          completedItems: completedSteps,
        });
      }

      // Step 3: Importance score recalculation (if enabled)
      if (this.config.enableImportanceRecalc) {
        const recalculated = await this.runImportanceRecalc();
        result.importanceRecalc.recalculated = recalculated;

        completedSteps++;
        checkpointManager.updateProgress(jobState.jobId, {
          processedItems: completedSteps,
          completedItems: completedSteps,
        });
      }

      result.duration = Date.now() - startTime;

      // Mark job as completed
      checkpointManager.updateStage(jobState.jobId, 'completed');

      logger.info('CleanupJob', 'Cleanup job completed', {
        jobId: jobState.jobId,
        duration: `${result.duration}ms`,
        memoryCleanup: result.memoryCleanup,
        accessCleanup: result.accessCleanup,
        importanceRecalc: result.importanceRecalc,
      });

      this.lastRun = result;
      this.currentJobId = null;
      return result;
    } catch (error: unknown) {
      result.duration = Date.now() - startTime;

      // Record error in checkpoint manager
      checkpointManager.recordError(jobState.jobId, error instanceof Error ? error : new Error(String(error)));

      logger.error('CleanupJob', 'Cleanup job failed', { jobId: jobState.jobId }, error instanceof Error ? error : new Error(String(error)));
      this.currentJobId = null;
      throw error;
    }
  }

  /**
   * Run memory cleanup using ForgettingPolicy
   */
  private async runMemoryCleanup(): Promise<{
    evaluated: number;
    deleted: number;
    candidates?: Array<{ id: number; title: string; reason: string }>;
  }> {
    const policy = new ForgettingPolicy(this.db);
    const candidates = await policy.getCleanupCandidates(this.config.memoryCleanupLimit);

    const result = await policy.applyForgetting(
      this.config.memoryCleanupLimit,
      this.config.memoryCleanupDryRun
    );

    return {
      evaluated: candidates.length,
      deleted: result.deleted,
      candidates: result.candidates,
    };
  }

  /**
   * Clean up old access tracking records
   */
  private async runAccessCleanup(): Promise<number> {
    const tracker = new AccessTracker(this.db);
    return await tracker.cleanup(this.config.accessCleanupOlderThanDays);
  }

  /**
   * Recalculate importance scores for recent memories
   * This ensures scores are accurate after access patterns change
   */
  private async runImportanceRecalc(): Promise<number> {
    const { ImportanceScorer } = await import('./ImportanceScorer.js');
    const scorer = new ImportanceScorer(this.db);

    // Get recent observations that haven't been updated in a while
    const stmt = this.db.prepare(`
      SELECT id FROM observations
      WHERE created_at_epoch > ?
      ORDER BY importance_score_updated_at ASC
      LIMIT ?
    `);

    // Look back configurable window (default: 6 months)
    const cutoff = Date.now() - (this.config.importanceRecalcLookbackDays * 24 * 60 * 60 * 1000);
    const rows = stmt.all(cutoff, this.config.importanceRecalcLimit) as Array<{ id: number }>;

    let recalculated = 0;

    for (const row of rows) {
      const result = await scorer.updateScore(row.id);
      if (result) {
        recalculated++;
      }
    }

    if (recalculated > 0) {
      logger.debug('CleanupJob', `Recalculated ${recalculated} importance scores`);
    }

    return recalculated;
  }

  /**
   * Start scheduled cleanup
   */
  startScheduled(): void {
    if (this.scheduledTimer) {
      logger.debug('CleanupJob', 'Cleanup already scheduled');
      return;
    }

    if (!this.config.enableMemoryCleanup && !this.config.enableAccessCleanup) {
      logger.debug('CleanupJob', 'Cleanup disabled, not scheduling');
      return;
    }

    const intervalMs = this.config.memoryCleanupIntervalHours * 60 * 60 * 1000;

    this.scheduledTimer = setInterval(async () => {
      try {
        await this.run();
      } catch (error) {
        logger.error('CleanupJob', 'Scheduled cleanup failed', {}, error);
      }
    }, intervalMs);

    logger.info('CleanupJob', `Scheduled cleanup every ${this.config.memoryCleanupIntervalHours} hours`);
  }

  /**
   * Stop scheduled cleanup
   */
  stopScheduled(): void {
    if (this.scheduledTimer) {
      clearInterval(this.scheduledTimer);
      this.scheduledTimer = null;
      logger.info('CleanupJob', 'Stopped scheduled cleanup');
    }
  }

  /**
   * Get the last cleanup result
   */
  getLastRun(): CleanupResult | null {
    return this.lastRun;
  }

  /**
   * Get current configuration
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CleanupConfig>): void {
    const wasScheduled = this.scheduledTimer !== null;

    // Stop scheduled if running
    this.stopScheduled();

    // Update config
    this.config = { ...this.config, ...config };

    logger.info('CleanupJob', 'Configuration updated', { config: this.config });

    // Restart if it was scheduled
    if (wasScheduled) {
      this.startScheduled();
    }
  }

  /**
   * Get cleanup statistics
   */
  getStats(): {
    isScheduled: boolean;
    lastRun?: CleanupResult;
    config: CleanupConfig;
    databaseSize: number;
    currentJobId?: string;
  } {
    let databaseSize = 0;

    // Get database file size for file-based databases
    try {
      const filename = (this.db as any).filename;
      if (filename && filename !== ':memory:') {
        const stats = statSync(filename);
        databaseSize = stats.size;
      }
    } catch (error) {
      // File doesn't exist or can't be accessed, size remains 0
      logger.debug('CLEANUP', 'Could not get database file size', { error });
    }

    return {
      isScheduled: this.scheduledTimer !== null,
      lastRun: this.lastRun ?? undefined,
      config: this.config,
      databaseSize,
      currentJobId: this.currentJobId ?? undefined,
    };
  }

  /**
   * Get current job ID if a cleanup is in progress
   */
  getCurrentJobId(): string | null {
    return this.currentJobId;
  }

  /**
   * Get state of current or specified job
   */
  getJobState(jobId?: string): ReturnType<typeof checkpointManager.getJob> {
    const id = jobId ?? this.currentJobId;
    if (!id) return null;
    return checkpointManager.getJob(id);
  }

  /**
   * Get events for current or specified job
   */
  getJobEvents(jobId?: string): ReturnType<typeof checkpointManager.getEvents> {
    const id = jobId ?? this.currentJobId;
    if (!id) return [];
    return checkpointManager.getEvents(id);
  }

  /**
   * List all cleanup jobs tracked by checkpoint manager
   */
  listAllJobs(): ReturnType<typeof checkpointManager.listJobs> {
    return checkpointManager.listJobs({ type: 'cleanup' });
  }
}

/**
 * Global singleton instance
 */
let globalInstance: CleanupJob | null = null;

/**
 * Initialize or get the global CleanupJob instance
 */
export function getCleanupJob(db: Database, config?: Partial<CleanupConfig>): CleanupJob {
  if (!globalInstance) {
    globalInstance = new CleanupJob(db, config);
  }
  return globalInstance;
}

/**
 * Destroy the global instance
 */
export function destroyCleanupJob(): void {
  if (globalInstance) {
    globalInstance.stopScheduled();
    globalInstance = null;
  }
}
