/**
 * Batch Job State Types for claude-mem
 *
 * Implements state tracking for batch operations:
 * - Compression jobs
 * - Cleanup jobs
 * - Sync jobs
 *
 * Features:
 * - Checkpoint/resume from interruption
 * - Parallel-safe processing
 * - Complete audit trail
 *
 * Based on pipeline architecture analysis recommendations.
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Job type identifiers
 */
export type BatchJobType = 'compression' | 'cleanup' | 'sync' | 'migration';

/**
 * Job execution stage
 */
export type BatchJobStage =
  | 'initializing'   // Setting up job
  | 'scanning'       // Finding items to process
  | 'scoring'        // Calculating scores (for cleanup)
  | 'deciding'       // Making decisions
  | 'executing'      // Processing items
  | 'finalizing'     // Cleanup and summary
  | 'completed'      // Successfully finished
  | 'failed'         // Failed with error
  | 'cancelled';     // Manually cancelled

/**
 * Item processing status
 */
export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

// ============================================================================
// Batch Job State
// ============================================================================

/**
 * Complete state for a batch job
 */
export interface BatchJobState {
  /** Unique job identifier */
  jobId: string;

  /** Type of batch job */
  type: BatchJobType;

  /** Current execution stage */
  stage: BatchJobStage;

  /** Job creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Start of execution timestamp */
  startedAt?: number;

  /** End of execution timestamp */
  completedAt?: number;

  /** Job configuration */
  config: BatchJobConfig;

  /** Processing progress */
  progress: BatchJobProgress;

  /** Checkpoint data for resume capability */
  checkpoint: BatchJobCheckpoint;

  /** Error information if failed */
  error?: BatchJobError;

  /** Job metadata */
  metadata: Record<string, unknown>;
}

/**
 * Job configuration
 */
export interface BatchJobConfig {
  /** Target scope (session ID, date range, etc.) */
  scope: {
    sessionId?: string;
    projectId?: string;
    dateFrom?: number;
    dateTo?: number;
    observationIds?: number[];
  };

  /** Processing options */
  options: {
    batchSize: number;
    maxConcurrency: number;
    timeoutMs: number;
    dryRun: boolean;
    skipOnError: boolean;
  };

  /** Type-specific configuration */
  typeConfig?: {
    // Cleanup-specific
    retentionDays?: number;
    minImportanceScore?: number;
    preserveTypes?: string[];

    // Compression-specific
    compressionLevel?: 'light' | 'medium' | 'heavy';

    // Sync-specific
    targetSystem?: string;
  };
}

/**
 * Job progress tracking
 */
export interface BatchJobProgress {
  /** Total items to process */
  totalItems: number;

  /** Items processed so far */
  processedItems: number;

  /** Items successfully completed */
  completedItems: number;

  /** Items that failed */
  failedItems: number;

  /** Items skipped */
  skippedItems: number;

  /** Estimated completion percentage */
  percentComplete: number;

  /** Estimated time remaining in ms */
  estimatedRemainingMs?: number;

  /** Processing rate (items/second) */
  processingRate?: number;
}

/**
 * Checkpoint data for resume capability
 */
export interface BatchJobCheckpoint {
  /** Last successfully processed item ID */
  lastProcessedId: number | null;

  /** Array of processed item IDs (for non-sequential processing) */
  processedIds: number[];

  /** Array of failed item IDs */
  failedIds: number[];

  /** Array of skipped item IDs */
  skippedIds: number[];

  /** Current batch number (for chunked processing) */
  currentBatch: number;

  /** Total number of batches */
  totalBatches: number;

  /** Stage-specific checkpoint data */
  stageData?: Record<string, unknown>;

  /** Checkpoint creation timestamp */
  checkpointedAt: number;
}

/**
 * Error information
 */
export interface BatchJobError {
  /** Error message */
  message: string;

  /** Error code */
  code?: string;

  /** Stack trace */
  stack?: string;

  /** Stage where error occurred */
  stage: BatchJobStage;

  /** Item ID that caused error (if applicable) */
  itemId?: number;

  /** Error timestamp */
  occurredAt: number;
}

// ============================================================================
// Job Item Types
// ============================================================================

/**
 * Individual item being processed
 */
export interface BatchJobItem {
  /** Item ID */
  id: number;

  /** Processing status */
  status: ItemStatus;

  /** Processing attempts */
  attempts: number;

  /** Last attempt timestamp */
  lastAttemptAt?: number;

  /** Error message if failed */
  error?: string;

  /** Processing result data */
  result?: Record<string, unknown>;
}

// ============================================================================
// Job Events
// ============================================================================

/**
 * Job event types for audit trail
 */
export type BatchJobEventType =
  | 'job_created'
  | 'job_started'
  | 'stage_changed'
  | 'item_processed'
  | 'item_failed'
  | 'checkpoint_saved'
  | 'job_resumed'
  | 'job_completed'
  | 'job_failed'
  | 'job_cancelled';

/**
 * Job event record
 */
export interface BatchJobEvent {
  /** Event ID */
  id: string;

  /** Job ID */
  jobId: string;

  /** Event type */
  type: BatchJobEventType;

  /** Event timestamp */
  timestamp: number;

  /** Event data */
  data: Record<string, unknown>;
}

// ============================================================================
// Job Manager Interface
// ============================================================================

/**
 * Interface for batch job management
 */
export interface BatchJobManager {
  /**
   * Create a new batch job
   */
  createJob(type: BatchJobType, config: BatchJobConfig): Promise<BatchJobState>;

  /**
   * Start job execution
   */
  startJob(jobId: string): Promise<void>;

  /**
   * Resume job from checkpoint
   */
  resumeJob(jobId: string): Promise<void>;

  /**
   * Pause job (save checkpoint)
   */
  pauseJob(jobId: string): Promise<void>;

  /**
   * Cancel job
   */
  cancelJob(jobId: string): Promise<void>;

  /**
   * Get job state
   */
  getJob(jobId: string): Promise<BatchJobState | null>;

  /**
   * List jobs by type or status
   */
  listJobs(filter?: {
    type?: BatchJobType;
    stage?: BatchJobStage;
    limit?: number;
  }): Promise<BatchJobState[]>;

  /**
   * Get job events (audit trail)
   */
  getJobEvents(jobId: string): Promise<BatchJobEvent[]>;

  /**
   * Clean up old completed jobs
   */
  cleanupOldJobs(olderThanDays: number): Promise<number>;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_BATCH_JOB_CONFIG: BatchJobConfig = {
  scope: {},
  options: {
    batchSize: 50,
    maxConcurrency: 5,
    timeoutMs: 300000, // 5 minutes
    dryRun: false,
    skipOnError: true
  }
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create initial job state
 */
export function createBatchJobState(
  type: BatchJobType,
  config: Partial<BatchJobConfig> = {}
): BatchJobState {
  const now = Date.now();
  const jobId = `job_${type}_${now}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    jobId,
    type,
    stage: 'initializing',
    createdAt: now,
    updatedAt: now,
    config: { ...DEFAULT_BATCH_JOB_CONFIG, ...config },
    progress: {
      totalItems: 0,
      processedItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
      percentComplete: 0
    },
    checkpoint: {
      lastProcessedId: null,
      processedIds: [],
      failedIds: [],
      skippedIds: [],
      currentBatch: 0,
      totalBatches: 0,
      checkpointedAt: now
    },
    metadata: {}
  };
}

/**
 * Calculate progress percentage
 */
export function calculateProgress(progress: BatchJobProgress): number {
  if (progress.totalItems === 0) return 0;
  return Math.round((progress.processedItems / progress.totalItems) * 100);
}

/**
 * Estimate remaining time based on processing rate
 */
export function estimateRemainingTime(progress: BatchJobProgress): number | undefined {
  if (!progress.processingRate || progress.processingRate === 0) return undefined;
  const remainingItems = progress.totalItems - progress.processedItems;
  return Math.round((remainingItems / progress.processingRate) * 1000);
}

/**
 * Check if job can be resumed
 */
export function canResumeJob(state: BatchJobState): boolean {
  return ['failed', 'cancelled'].includes(state.stage) &&
    state.checkpoint.processedIds.length > 0;
}
