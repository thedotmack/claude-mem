/**
 * Health Routes
 *
 * Provides system health monitoring endpoints for self-aware logging:
 * - System health summary (errors, warnings, patterns)
 * - Recent logs querying
 * - Error pattern management
 * - Log cleanup
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SystemLogLevel } from '../../../../types/database.js';

export class HealthRoutes extends BaseRouteHandler {
  constructor(private sessionStore: SessionStore) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Health summary
    app.get('/api/health/summary', this.handleGetHealthSummary.bind(this));

    // System logs
    app.get('/api/logs', this.handleGetLogs.bind(this));
    app.delete('/api/logs/cleanup', this.handleCleanupLogs.bind(this));

    // Error patterns
    app.get('/api/errors/patterns', this.handleGetErrorPatterns.bind(this));
    app.post('/api/errors/patterns/:hash/resolve', this.handleResolvePattern.bind(this));
  }

  /**
   * GET /api/health/summary
   * Returns system health summary including error counts and patterns
   */
  private handleGetHealthSummary = this.wrapHandler((_req: Request, res: Response): void => {
    const summary = this.sessionStore.getSystemHealthSummary();

    res.json({
      success: true,
      data: {
        ...summary,
        status: this.determineHealthStatus(summary.errorCount24h, summary.unresolvedPatterns)
      }
    });
  });

  /**
   * GET /api/logs
   * Query system logs with optional filters
   * Query params: level, component, limit, since (epoch)
   */
  private handleGetLogs = this.wrapHandler((req: Request, res: Response): void => {
    const {
      level,
      component,
      limit = '100',
      since
    } = req.query;

    const options: {
      level?: SystemLogLevel;
      component?: string;
      limit?: number;
      since?: number;
    } = {
      limit: Math.min(parseInt(limit as string, 10) || 100, 500)
    };

    if (level && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level as string)) {
      options.level = level as SystemLogLevel;
    }
    if (component) {
      options.component = component as string;
    }
    if (since) {
      options.since = parseInt(since as string, 10);
    }

    const logs = this.sessionStore.getRecentSystemLogs(options);

    res.json({
      success: true,
      data: {
        logs,
        count: logs.length
      }
    });
  });

  /**
   * DELETE /api/logs/cleanup
   * Delete logs older than specified days
   * Query params: olderThanDays (default: 30)
   */
  private handleCleanupLogs = this.wrapHandler((req: Request, res: Response): void => {
    const olderThanDays = parseInt(req.query.olderThanDays as string, 10) || 30;

    if (olderThanDays < 1 || olderThanDays > 365) {
      this.badRequest(res, 'olderThanDays must be between 1 and 365');
      return;
    }

    const deleted = this.sessionStore.cleanupOldSystemLogs(olderThanDays);

    res.json({
      success: true,
      data: {
        deletedCount: deleted,
        olderThanDays
      }
    });
  });

  /**
   * GET /api/errors/patterns
   * Get error patterns sorted by occurrence count
   * Query params: resolved, component, limit, minOccurrences
   */
  private handleGetErrorPatterns = this.wrapHandler((req: Request, res: Response): void => {
    const {
      resolved,
      component,
      limit = '50',
      minOccurrences = '1'
    } = req.query;

    const options: {
      resolved?: boolean;
      component?: string;
      limit?: number;
      minOccurrences?: number;
    } = {
      limit: Math.min(parseInt(limit as string, 10) || 50, 200),
      minOccurrences: parseInt(minOccurrences as string, 10) || 1
    };

    if (resolved !== undefined) {
      options.resolved = resolved === 'true';
    }
    if (component) {
      options.component = component as string;
    }

    const patterns = this.sessionStore.getErrorPatterns(options);

    res.json({
      success: true,
      data: {
        patterns,
        count: patterns.length
      }
    });
  });

  /**
   * POST /api/errors/patterns/:hash/resolve
   * Mark an error pattern as resolved
   * Body: { notes: string, autoResolution?: object }
   */
  private handleResolvePattern = this.wrapHandler((req: Request, res: Response): void => {
    const { hash } = req.params;
    const { notes, autoResolution } = req.body;

    if (!hash) {
      this.badRequest(res, 'Missing error hash');
      return;
    }
    if (!notes || typeof notes !== 'string') {
      this.badRequest(res, 'Resolution notes required');
      return;
    }

    const resolved = this.sessionStore.resolveErrorPattern(hash, notes, autoResolution);

    if (!resolved) {
      this.notFound(res, 'Error pattern not found');
      return;
    }

    res.json({
      success: true,
      message: 'Error pattern marked as resolved'
    });
  });

  /**
   * Determine overall health status based on metrics
   */
  private determineHealthStatus(errorCount24h: number, unresolvedPatterns: number): 'healthy' | 'warning' | 'critical' {
    if (errorCount24h > 100 || unresolvedPatterns > 20) {
      return 'critical';
    }
    if (errorCount24h > 20 || unresolvedPatterns > 5) {
      return 'warning';
    }
    return 'healthy';
  }
}
