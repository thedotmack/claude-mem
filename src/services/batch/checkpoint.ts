/**
 * Checkpoint Service for Batch Jobs
 *
 * Provides:
 * - Periodic checkpoint saving
 * - Resume from checkpoint
 * - State persistence
 * - Audit event logging
 */

import { logger } from '../../utils/logger.js';
import {
  type BatchJobState,
  type BatchJobCheckpoint,
  type BatchJobEvent,
  type BatchJobEventType,
  type BatchJobStage,
  type ItemStatus,
  calculateProgress,
  estimateRemainingTime
} from '../../types/batch-job.js';

// ============================================================================
// Checkpoint Manager
// ============================================================================

export class CheckpointManager {
  private jobs: Map<string, BatchJobState> = new Map();
  private events: Map<string, BatchJobEvent[]> = new Map();
  private checkpointInterval: number;
  private autoCheckpointTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: { checkpointIntervalMs?: number } = {}) {
    this.checkpointInterval = options.checkpointIntervalMs ?? 30000; // 30 seconds default
  }

  // ============================================================================
  // Job Lifecycle
  // ============================================================================

  /**
   * Register a new job
   */
  registerJob(state: BatchJobState): void {
    this.jobs.set(state.jobId, state);
    this.events.set(state.jobId, []);
    this.logEvent(state.jobId, 'job_created', { config: state.config });

    logger.info('CHECKPOINT', 'Job registered', {
      jobId: state.jobId,
      type: state.type
    });
  }

  /**
   * Start auto-checkpointing for a job
   */
  startAutoCheckpoint(jobId: string): void {
    if (this.autoCheckpointTimers.has(jobId)) {
      return;
    }

    const timer = setInterval(() => {
      this.saveCheckpoint(jobId);
    }, this.checkpointInterval);

    this.autoCheckpointTimers.set(jobId, timer);

    logger.debug('CHECKPOINT', 'Auto-checkpoint started', {
      jobId,
      intervalMs: this.checkpointInterval
    });
  }

  /**
   * Stop auto-checkpointing for a job
   */
  stopAutoCheckpoint(jobId: string): void {
    const timer = this.autoCheckpointTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.autoCheckpointTimers.delete(jobId);
    }
  }

  // ============================================================================
  // State Updates
  // ============================================================================

  /**
   * Update job stage
   */
  updateStage(jobId: string, stage: BatchJobStage): void {
    const state = this.jobs.get(jobId);
    if (!state) {
      logger.warn('CHECKPOINT', 'Job not found for stage update', { jobId });
      return;
    }

    const previousStage = state.stage;
    state.stage = stage;
    state.updatedAt = Date.now();

    if (stage === 'executing' && !state.startedAt) {
      state.startedAt = Date.now();
    }

    if (['completed', 'failed', 'cancelled'].includes(stage)) {
      state.completedAt = Date.now();
      this.stopAutoCheckpoint(jobId);
    }

    this.logEvent(jobId, 'stage_changed', {
      previousStage,
      newStage: stage
    });

    logger.info('CHECKPOINT', 'Job stage updated', {
      jobId,
      previousStage,
      newStage: stage
    });
  }

  /**
   * Update progress
   */
  updateProgress(
    jobId: string,
    update: Partial<BatchJobState['progress']>
  ): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    Object.assign(state.progress, update);
    state.progress.percentComplete = calculateProgress(state.progress);
    state.progress.estimatedRemainingMs = estimateRemainingTime(state.progress);
    state.updatedAt = Date.now();
  }

  /**
   * Record item processing result
   */
  recordItemResult(
    jobId: string,
    itemId: number,
    status: ItemStatus,
    error?: string
  ): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    const checkpoint = state.checkpoint;

    switch (status) {
      case 'completed':
        checkpoint.processedIds.push(itemId);
        state.progress.completedItems++;
        break;
      case 'failed':
        checkpoint.failedIds.push(itemId);
        state.progress.failedItems++;
        this.logEvent(jobId, 'item_failed', { itemId, error });
        break;
      case 'skipped':
        checkpoint.skippedIds.push(itemId);
        state.progress.skippedItems++;
        break;
    }

    state.progress.processedItems++;
    checkpoint.lastProcessedId = itemId;
    state.updatedAt = Date.now();

    // Log every 100 items
    if (state.progress.processedItems % 100 === 0) {
      this.logEvent(jobId, 'item_processed', {
        processedCount: state.progress.processedItems,
        percentComplete: state.progress.percentComplete
      });
    }
  }

  /**
   * Update batch progress
   */
  updateBatchProgress(jobId: string, currentBatch: number, totalBatches: number): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    state.checkpoint.currentBatch = currentBatch;
    state.checkpoint.totalBatches = totalBatches;
    state.updatedAt = Date.now();
  }

  // ============================================================================
  // Checkpoint Operations
  // ============================================================================

  /**
   * Save checkpoint
   */
  saveCheckpoint(jobId: string): BatchJobCheckpoint | null {
    const state = this.jobs.get(jobId);
    if (!state) {
      logger.warn('CHECKPOINT', 'Job not found for checkpoint', { jobId });
      return null;
    }

    state.checkpoint.checkpointedAt = Date.now();
    state.updatedAt = Date.now();

    this.logEvent(jobId, 'checkpoint_saved', {
      processedCount: state.checkpoint.processedIds.length,
      failedCount: state.checkpoint.failedIds.length,
      lastProcessedId: state.checkpoint.lastProcessedId
    });

    logger.debug('CHECKPOINT', 'Checkpoint saved', {
      jobId,
      processedCount: state.checkpoint.processedIds.length,
      currentBatch: state.checkpoint.currentBatch
    });

    // In a real implementation, this would persist to database
    return { ...state.checkpoint };
  }

  /**
   * Load checkpoint and prepare for resume
   */
  loadCheckpoint(jobId: string): BatchJobCheckpoint | null {
    const state = this.jobs.get(jobId);
    if (!state) {
      logger.warn('CHECKPOINT', 'Job not found for checkpoint load', { jobId });
      return null;
    }

    logger.info('CHECKPOINT', 'Checkpoint loaded', {
      jobId,
      processedCount: state.checkpoint.processedIds.length,
      currentBatch: state.checkpoint.currentBatch
    });

    return { ...state.checkpoint };
  }

  /**
   * Resume job from checkpoint
   */
  resumeFromCheckpoint(jobId: string): {
    checkpoint: BatchJobCheckpoint;
    remainingIds: number[];
  } | null {
    const state = this.jobs.get(jobId);
    if (!state) {
      logger.warn('CHECKPOINT', 'Job not found for resume', { jobId });
      return null;
    }

    // Reset stage to executing
    state.stage = 'executing';
    state.updatedAt = Date.now();
    state.error = undefined;

    this.logEvent(jobId, 'job_resumed', {
      fromStage: state.stage,
      checkpointedAt: state.checkpoint.checkpointedAt,
      processedCount: state.checkpoint.processedIds.length
    });

    // Calculate remaining IDs (would need to be provided externally in real impl)
    const processedSet = new Set([
      ...state.checkpoint.processedIds,
      ...state.checkpoint.failedIds,
      ...state.checkpoint.skippedIds
    ]);

    logger.info('CHECKPOINT', 'Job resumed from checkpoint', {
      jobId,
      alreadyProcessed: processedSet.size
    });

    // Start auto-checkpoint again
    this.startAutoCheckpoint(jobId);

    return {
      checkpoint: { ...state.checkpoint },
      remainingIds: [] // Would be calculated from scope
    };
  }

  // ============================================================================
  // Error Handling
  // ============================================================================

  /**
   * Record job error
   */
  recordError(
    jobId: string,
    error: Error,
    itemId?: number
  ): void {
    const state = this.jobs.get(jobId);
    if (!state) return;

    state.error = {
      message: error.message,
      stack: error.stack,
      stage: state.stage,
      itemId,
      occurredAt: Date.now()
    };

    state.stage = 'failed';
    state.updatedAt = Date.now();
    state.completedAt = Date.now();

    this.stopAutoCheckpoint(jobId);

    this.logEvent(jobId, 'job_failed', {
      error: error.message,
      stage: state.stage,
      itemId
    });

    logger.error('CHECKPOINT', 'Job failed', {
      jobId,
      error: error.message,
      stage: state.stage
    });
  }

  // ============================================================================
  // Event Logging
  // ============================================================================

  /**
   * Log an event for audit trail
   */
  private logEvent(
    jobId: string,
    type: BatchJobEventType,
    data: Record<string, unknown>
  ): void {
    const events = this.events.get(jobId);
    if (!events) return;

    events.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      jobId,
      type,
      timestamp: Date.now(),
      data
    });
  }

  /**
   * Get events for a job
   */
  getEvents(jobId: string): BatchJobEvent[] {
    return this.events.get(jobId) || [];
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get job state
   */
  getJob(jobId: string): BatchJobState | null {
    return this.jobs.get(jobId) || null;
  }

  /**
   * List all jobs
   */
  listJobs(filter?: {
    type?: BatchJobState['type'];
    stage?: BatchJobStage;
  }): BatchJobState[] {
    let jobs = Array.from(this.jobs.values());

    if (filter?.type) {
      jobs = jobs.filter(j => j.type === filter.type);
    }

    if (filter?.stage) {
      jobs = jobs.filter(j => j.stage === filter.stage);
    }

    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get job statistics
   */
  getStats(): {
    totalJobs: number;
    byStage: Record<BatchJobStage, number>;
    byType: Record<string, number>;
  } {
    const jobs = Array.from(this.jobs.values());

    const byStage: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const job of jobs) {
      byStage[job.stage] = (byStage[job.stage] || 0) + 1;
      byType[job.type] = (byType[job.type] || 0) + 1;
    }

    return {
      totalJobs: jobs.length,
      byStage: byStage as Record<BatchJobStage, number>,
      byType
    };
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Remove completed jobs older than specified days
   */
  cleanupOldJobs(olderThanDays: number): number {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let removed = 0;

    for (const [jobId, state] of this.jobs.entries()) {
      if (
        ['completed', 'failed', 'cancelled'].includes(state.stage) &&
        (state.completedAt || state.createdAt) < cutoff
      ) {
        this.jobs.delete(jobId);
        this.events.delete(jobId);
        removed++;
      }
    }

    logger.info('CHECKPOINT', 'Cleaned up old jobs', {
      removed,
      olderThanDays
    });

    return removed;
  }

  /**
   * Shutdown - stop all timers
   */
  shutdown(): void {
    for (const timer of this.autoCheckpointTimers.values()) {
      clearInterval(timer);
    }
    this.autoCheckpointTimers.clear();
  }
}

// Export singleton instance
export const checkpointManager = new CheckpointManager();
