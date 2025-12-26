/**
 * Metrics Routes
 *
 * Exposes pipeline metrics, parsing statistics, and job status for monitoring.
 * These endpoints enable visibility into the memory processing system.
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { getParseMetrics, getParseSuccessRate } from '../../../../sdk/parser.js';
import { checkpointManager } from '../../../batch/checkpoint.js';
import { getCleanupJob } from '../../CleanupJob.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

export class MetricsRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Parsing metrics
    app.get('/api/metrics/parsing', this.handleParsingMetrics.bind(this));

    // Job status
    app.get('/api/metrics/jobs', this.handleJobList.bind(this));
    app.get('/api/metrics/jobs/:jobId', this.handleJobDetail.bind(this));
    app.get('/api/metrics/jobs/:jobId/events', this.handleJobEvents.bind(this));

    // Cleanup job status
    app.get('/api/metrics/cleanup', this.handleCleanupStatus.bind(this));

    // Combined dashboard metrics
    app.get('/api/metrics/dashboard', this.handleDashboard.bind(this));
  }

  /**
   * GET /api/metrics/parsing
   * Returns parsing success rate and metrics
   */
  private handleParsingMetrics = this.wrapHandler((_req: Request, res: Response): void => {
    const metrics = getParseMetrics();
    const successRate = getParseSuccessRate();

    res.json({
      successRate: Math.round(successRate * 10) / 10,
      successRateFormatted: `${successRate.toFixed(1)}%`,
      totalExtractions: metrics.totalExtractions,
      successfulExtractions: metrics.successfulExtractions,
      fallbacksUsed: metrics.fallbacksUsed,
      fallbackRate: metrics.totalExtractions > 0
        ? Math.round((metrics.fallbacksUsed / metrics.totalExtractions) * 1000) / 10
        : 0
    });
  });

  /**
   * GET /api/metrics/jobs
   * Returns list of all batch jobs
   */
  private handleJobList = this.wrapHandler((req: Request, res: Response): void => {
    const type = req.query.type as string | undefined;
    const stage = req.query.stage as string | undefined;

    const jobs = checkpointManager.listJobs({
      type: type as any,
      stage: stage as any
    });

    const stats = checkpointManager.getStats();

    res.json({
      jobs: jobs.map(job => ({
        jobId: job.jobId,
        type: job.type,
        stage: job.stage,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        hasError: !!job.error
      })),
      stats
    });
  });

  /**
   * GET /api/metrics/jobs/:jobId
   * Returns detailed job state
   */
  private handleJobDetail = this.wrapHandler((req: Request, res: Response): void => {
    const { jobId } = req.params;

    const job = checkpointManager.getJob(jobId);
    if (!job) {
      return this.notFound(res, `Job ${jobId} not found`);
    }

    res.json({
      ...job,
      checkpoint: {
        ...job.checkpoint,
        processedCount: job.checkpoint.processedIds.length,
        failedCount: job.checkpoint.failedIds.length,
        skippedCount: job.checkpoint.skippedIds.length
      }
    });
  });

  /**
   * GET /api/metrics/jobs/:jobId/events
   * Returns job audit events
   */
  private handleJobEvents = this.wrapHandler((req: Request, res: Response): void => {
    const { jobId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;

    const events = checkpointManager.getEvents(jobId);
    const limitedEvents = events.slice(-limit);

    res.json({
      jobId,
      totalEvents: events.length,
      events: limitedEvents
    });
  });

  /**
   * GET /api/metrics/cleanup
   * Returns cleanup job status
   */
  private handleCleanupStatus = this.wrapHandler((_req: Request, res: Response): void => {
    try {
      const db = this.dbManager.getSessionStore().db;
      const cleanupJob = getCleanupJob(db);
      const stats = cleanupJob.getStats();

      res.json({
        ...stats,
        recentJobs: cleanupJob.listAllJobs().slice(0, 10)
      });
    } catch (error) {
      // CleanupJob might not be initialized
      res.json({
        isScheduled: false,
        config: null,
        error: 'CleanupJob not initialized'
      });
    }
  });

  /**
   * GET /api/metrics/dashboard
   * Returns combined metrics for dashboard display
   */
  private handleDashboard = this.wrapHandler((_req: Request, res: Response): void => {
    // Parsing metrics
    const parseMetrics = getParseMetrics();
    const parseSuccessRate = getParseSuccessRate();

    // Job stats
    const jobStats = checkpointManager.getStats();

    // Get active jobs
    const activeJobs = checkpointManager.listJobs()
      .filter(j => !['completed', 'failed', 'cancelled'].includes(j.stage))
      .slice(0, 5);

    // Get recent completed jobs
    const recentJobs = checkpointManager.listJobs()
      .filter(j => ['completed', 'failed', 'cancelled'].includes(j.stage))
      .slice(0, 5);

    res.json({
      parsing: {
        successRate: parseSuccessRate,
        successRateFormatted: `${parseSuccessRate.toFixed(1)}%`,
        totalExtractions: parseMetrics.totalExtractions,
        fallbacksUsed: parseMetrics.fallbacksUsed
      },
      jobs: {
        total: jobStats.totalJobs,
        byStage: jobStats.byStage,
        byType: jobStats.byType,
        active: activeJobs.map(j => ({
          jobId: j.jobId,
          type: j.type,
          stage: j.stage,
          progress: j.progress.percentComplete
        })),
        recent: recentJobs.map(j => ({
          jobId: j.jobId,
          type: j.type,
          stage: j.stage,
          completedAt: j.completedAt,
          duration: j.completedAt && j.startedAt
            ? j.completedAt - j.startedAt
            : null
        }))
      },
      timestamp: Date.now()
    });
  });
}
