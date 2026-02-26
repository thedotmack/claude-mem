/**
 * Pipeline Metrics - Stage timing and success tracking
 *
 * Provides metrics collection for observation processing stages,
 * compatible with both the legacy SDKAgent flow and future pipeline flow.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export type MetricStage =
  | 'acquire'    // Raw data capture
  | 'prepare'    // Normalization
  | 'process'    // LLM call
  | 'parse'      // Response parsing
  | 'render'     // Storage
  | 'chroma'     // Vector sync
  | 'surprise'   // Surprise calculation
  | 'broadcast'; // SSE broadcast

export interface StageMetric {
  stage: MetricStage;
  durationMs: number;
  success: boolean;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface StageStats {
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  successRate: number;
  lastExecuted: number | null;
}

export interface PipelineStats {
  stages: Record<MetricStage, StageStats>;
  totalExecutions: number;
  avgTotalDurationMs: number;
  lastExecution: number | null;
}

// ============================================================================
// Pipeline Metrics Collector
// ============================================================================

class PipelineMetricsCollector {
  private metrics: StageMetric[] = [];
  private executionStarts: Map<string, number> = new Map();
  private maxMetrics = 10000; // Keep last 10k metrics

  /**
   * Start timing a stage
   */
  startStage(stage: MetricStage, executionId?: string): string {
    const id = executionId || `${stage}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.executionStarts.set(id, Date.now());
    return id;
  }

  /**
   * End timing a stage and record the metric
   */
  endStage(
    stage: MetricStage,
    executionId: string,
    success: boolean = true,
    metadata?: Record<string, unknown>
  ): StageMetric {
    const startTime = this.executionStarts.get(executionId);
    const endTime = Date.now();
    const durationMs = startTime ? endTime - startTime : 0;

    this.executionStarts.delete(executionId);

    const metric: StageMetric = {
      stage,
      durationMs,
      success,
      timestamp: endTime,
      metadata
    };

    this.metrics.push(metric);
    this.pruneOldMetrics();

    logger.debug('PIPELINE', `Stage ${stage} completed`, {
      durationMs,
      success,
      ...metadata
    });

    return metric;
  }

  /**
   * Record a stage metric directly (for synchronous operations)
   */
  recordStage(
    stage: MetricStage,
    durationMs: number,
    success: boolean = true,
    metadata?: Record<string, unknown>
  ): StageMetric {
    const metric: StageMetric = {
      stage,
      durationMs,
      success,
      timestamp: Date.now(),
      metadata
    };

    this.metrics.push(metric);
    this.pruneOldMetrics();

    return metric;
  }

  /**
   * Get statistics for a specific stage
   */
  getStageStats(stage: MetricStage, windowMs: number = 3600000): StageStats {
    const cutoff = Date.now() - windowMs;
    const stageMetrics = this.metrics.filter(
      m => m.stage === stage && m.timestamp > cutoff
    );

    if (stageMetrics.length === 0) {
      return {
        count: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
        successRate: 0,
        lastExecuted: null
      };
    }

    const durations = stageMetrics.map(m => m.durationMs);
    const successCount = stageMetrics.filter(m => m.success).length;

    return {
      count: stageMetrics.length,
      totalDurationMs: durations.reduce((a, b) => a + b, 0),
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / stageMetrics.length),
      minDurationMs: Math.min(...durations),
      maxDurationMs: Math.max(...durations),
      successRate: Math.round((successCount / stageMetrics.length) * 100),
      lastExecuted: Math.max(...stageMetrics.map(m => m.timestamp))
    };
  }

  /**
   * Get statistics for all stages
   */
  getAllStats(windowMs: number = 3600000): PipelineStats {
    const stages: MetricStage[] = [
      'acquire', 'prepare', 'process', 'parse', 'render', 'chroma', 'surprise', 'broadcast'
    ];

    const stageStats: Record<MetricStage, StageStats> = {} as Record<MetricStage, StageStats>;
    for (const stage of stages) {
      stageStats[stage] = this.getStageStats(stage, windowMs);
    }

    // Calculate total execution stats
    const cutoff = Date.now() - windowMs;
    const recentMetrics = this.metrics.filter(m => m.timestamp > cutoff);
    const totalDuration = recentMetrics.reduce((a, m) => a + m.durationMs, 0);

    // Group by approximate execution (within 1 second)
    const executions = new Set<number>();
    for (const m of recentMetrics) {
      executions.add(Math.floor(m.timestamp / 1000));
    }

    return {
      stages: stageStats,
      totalExecutions: executions.size,
      avgTotalDurationMs: executions.size > 0
        ? Math.round(totalDuration / executions.size)
        : 0,
      lastExecution: recentMetrics.length > 0
        ? Math.max(...recentMetrics.map(m => m.timestamp))
        : null
    };
  }

  /**
   * Get recent metrics for debugging
   */
  getRecentMetrics(limit: number = 100): StageMetric[] {
    return this.metrics.slice(-limit);
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
    this.executionStarts.clear();
  }

  private pruneOldMetrics(): void {
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const pipelineMetrics = new PipelineMetricsCollector();

/**
 * Helper function to time an async operation
 */
export async function withMetrics<T>(
  stage: MetricStage,
  operation: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const executionId = pipelineMetrics.startStage(stage);
  try {
    const result = await operation();
    pipelineMetrics.endStage(stage, executionId, true, metadata);
    return result;
  } catch (error) {
    pipelineMetrics.endStage(stage, executionId, false, {
      ...metadata,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Helper function to time a sync operation
 */
export function withMetricsSync<T>(
  stage: MetricStage,
  operation: () => T,
  metadata?: Record<string, unknown>
): T {
  const start = Date.now();
  try {
    const result = operation();
    pipelineMetrics.recordStage(stage, Date.now() - start, true, metadata);
    return result;
  } catch (error) {
    pipelineMetrics.recordStage(stage, Date.now() - start, false, {
      ...metadata,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
