/**
 * CleanupJob: Scheduled memory cleanup operations
 *
 * Responsibility:
 * - Run periodic cleanup of low-value memories
 * - Clean up old access tracking records
 * - Maintain healthy database size
 * - Provide cleanup statistics and logging
 * - Track job state with checkpoint/resume capability
 *
 * Core concept from Titans: Adaptive weight decay to manage finite capacity
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { ForgettingPolicy } from './ForgettingPolicy.js';
import { AccessTracker } from './AccessTracker.js';
import { checkpointManager } from '../batch/checkpoint.js';
import { createBatchJobState, type BatchJobState, type BatchJobStage } from '../../types/batch-job.js';

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
 *
 * Features checkpoint/resume capability for long-running cleanup operations.
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
   * Get the current job ID (if running)
   */
  getCurrentJobId(): string | null {
    return this.currentJobId;
  }

  /**
   * Get job state from checkpoint manager
   */
  getJobState(): BatchJobState | null {
    if (!this.currentJobId) return null;
    return checkpointManager.getJob(this.currentJobId);
  }

  /**
   * Run a single cleanup pass with checkpoint tracking
   */
  async run(): Promise<CleanupResult> {
    const startTime = Date.now();

    // Create and register batch job state
    const jobState = createBatchJobState('cleanup', {
      options: {
        batchSize: this.config.memoryCleanupLimit,
        maxConcurrency: 1,
        timeoutMs: 3600000, // 1 hour
        dryRun: this.config.memoryCleanupDryRun,
        skipOnError: true
      },
      typeConfig: {
        retentionDays: this.config.accessCleanupOlderThanDays
      }
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

    // Calculate total items (estimate for progress tracking)
    const totalPhases = [
      this.config.enableMemoryCleanup,
      this.config.enableAccessCleanup,
      this.config.enableImportanceRecalc
    ].filter(Boolean).length;

    checkpointManager.updateProgress(jobState.jobId, {
      totalItems: totalPhases,
      processedItems: 0
    });

    try {
      // Update stage to scanning
      checkpointManager.updateStage(jobState.jobId, 'scanning');

      // Step 1: Memory cleanup (if enabled)
      if (this.config.enableMemoryCleanup) {
        checkpointManager.updateStage(jobState.jobId, 'executing');
        checkpointManager.updateBatchProgress(jobState.jobId, 1, totalPhases);

        const memoryResult = await this.runMemoryCleanup();
        result.memoryCleanup.evaluated = memoryResult.evaluated;
        result.memoryCleanup.deleted = memoryResult.deleted;
        result.memoryCleanup.candidates = memoryResult.candidates;

        checkpointManager.recordItemResult(jobState.jobId, 1, 'completed');

        // Save checkpoint after memory cleanup
        checkpointManager.saveCheckpoint(jobState.jobId);
      }

      // Step 2: Access tracking cleanup (if enabled)
      if (this.config.enableAccessCleanup) {
        checkpointManager.updateBatchProgress(jobState.jobId, 2, totalPhases);

        const deletedRecords = await this.runAccessCleanup();
        result.accessCleanup.deletedRecords = deletedRecords;

        checkpointManager.recordItemResult(jobState.jobId, 2, 'completed');
      }

      // Step 3: Importance score recalculation (if enabled)
      if (this.config.enableImportanceRecalc) {
        checkpointManager.updateBatchProgress(jobState.jobId, 3, totalPhases);

        const recalculated = await this.runImportanceRecalc();
        result.importanceRecalc.recalculated = recalculated;

        checkpointManager.recordItemResult(jobState.jobId, 3, 'completed');
      }

      // Finalize
      checkpointManager.updateStage(jobState.jobId, 'finalizing');
      result.duration = Date.now() - startTime;

      // Mark completed
      checkpointManager.updateStage(jobState.jobId, 'completed');
      checkpointManager.saveCheckpoint(jobState.jobId);

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
    } catch (error: any) {
      result.duration = Date.now() - startTime;

      // Record error in checkpoint manager
      checkpointManager.recordError(jobState.jobId, error);

      logger.error('CleanupJob', 'Cleanup job failed', { jobId: jobState.jobId }, error);
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

    // Look back 6 months
    const cutoff = Date.now() - (180 * 24 * 60 * 60 * 1000);
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
    currentJobState?: BatchJobState | null;
  } {
    const dbPath = this.db.serialize ? 'in-memory' : 'file';

    return {
      isScheduled: this.scheduledTimer !== null,
      lastRun: this.lastRun ?? undefined,
      config: this.config,
      databaseSize: dbPath === 'file' ? 0 : 0, // TODO: implement file size check
      currentJobId: this.currentJobId ?? undefined,
      currentJobState: this.currentJobId ? checkpointManager.getJob(this.currentJobId) : undefined
    };
  }

  /**
   * Get audit events for the current or specified job
   */
  getJobEvents(jobId?: string): import('../../types/batch-job.js').BatchJobEvent[] {
    const targetJobId = jobId ?? this.currentJobId;
    if (!targetJobId) return [];
    return checkpointManager.getEvents(targetJobId);
  }

  /**
   * List all cleanup jobs from checkpoint manager
   */
  listAllJobs(): BatchJobState[] {
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
