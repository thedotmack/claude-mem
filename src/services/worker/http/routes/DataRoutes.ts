/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via domain services.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';

export class DataRoutes {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {}

  setupRoutes(app: express.Application): void {
    // Pagination endpoints
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    // Fetch by ID endpoints
    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    // Metadata endpoints
    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    // Processing status endpoints
    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', this.handleSetProcessing.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations(req: Request, res: Response): void {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const result = this.paginationHelper.getObservations(offset, limit, project);
      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Get observations failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get paginated summaries
   */
  private handleGetSummaries(req: Request, res: Response): void {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const result = this.paginationHelper.getSummaries(offset, limit, project);
      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Get summaries failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts(req: Request, res: Response): void {
    try {
      const { offset, limit, project } = this.parsePaginationParams(req);
      const result = this.paginationHelper.getPrompts(offset, limit, project);
      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Get prompts failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get observation by ID
   * GET /api/observation/:id
   */
  private handleGetObservationById(req: Request, res: Response): void {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid observation ID' });
        return;
      }

      const store = this.dbManager.getSessionStore();
      const observation = store.getObservationById(id);

      if (!observation) {
        res.status(404).json({ error: `Observation #${id} not found` });
        return;
      }

      res.json(observation);
    } catch (error) {
      logger.failure('WORKER', 'Get observation by ID failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get session by ID
   * GET /api/session/:id
   */
  private handleGetSessionById(req: Request, res: Response): void {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid session ID' });
        return;
      }

      const store = this.dbManager.getSessionStore();
      const sessions = store.getSessionSummariesByIds([id]);

      if (sessions.length === 0) {
        res.status(404).json({ error: `Session #${id} not found` });
        return;
      }

      res.json(sessions[0]);
    } catch (error) {
      logger.failure('WORKER', 'Get session by ID failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get user prompt by ID
   * GET /api/prompt/:id
   */
  private handleGetPromptById(req: Request, res: Response): void {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid prompt ID' });
        return;
      }

      const store = this.dbManager.getSessionStore();
      const prompts = store.getUserPromptsByIds([id]);

      if (prompts.length === 0) {
        res.status(404).json({ error: `Prompt #${id} not found` });
        return;
      }

      res.json(prompts[0]);
    } catch (error) {
      logger.failure('WORKER', 'Get prompt by ID failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get database statistics (with worker metadata)
   */
  private handleGetStats(req: Request, res: Response): void {
    try {
      const db = this.dbManager.getSessionStore().db;

      // Read version from package.json
      const packageRoot = getPackageRoot();
      const packageJsonPath = path.join(packageRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const version = packageJson.version;

      // Get database stats
      const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

      // Get database file size and path
      const dbPath = path.join(homedir(), '.claude-mem', 'claude-mem.db');
      let dbSize = 0;
      if (existsSync(dbPath)) {
        dbSize = statSync(dbPath).size;
      }

      // Worker metadata
      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      const activeSessions = this.sessionManager.getActiveSessionCount();
      const sseClients = this.sseBroadcaster.getClientCount();

      res.json({
        worker: {
          version,
          uptime,
          activeSessions,
          sseClients,
          port: getWorkerPort()
        },
        database: {
          path: dbPath,
          size: dbSize,
          observations: totalObservations.count,
          sessions: totalSessions.count,
          summaries: totalSummaries.count
        }
      });
    } catch (error) {
      logger.failure('WORKER', 'Get stats failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   */
  private handleGetProjects(req: Request, res: Response): void {
    try {
      const db = this.dbManager.getSessionStore().db;

      const rows = db.prepare(`
        SELECT DISTINCT project
        FROM observations
        WHERE project IS NOT NULL
        GROUP BY project
        ORDER BY MAX(created_at_epoch) DESC
      `).all() as Array<{ project: string }>;

      const projects = rows.map(row => row.project);

      res.json({ projects });
    } catch (error) {
      logger.failure('WORKER', 'Get projects failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get current processing status
   * GET /api/processing-status
   */
  private handleGetProcessingStatus(req: Request, res: Response): void {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  }

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing(req: Request, res: Response): void {
    try {
      // Broadcast current computed status (ignores manual input)
      this.workerService.broadcastProcessingStatus();

      const isProcessing = this.sessionManager.isAnySessionProcessing();
      const queueDepth = this.sessionManager.getTotalQueueDepth();
      const activeSessions = this.sessionManager.getActiveSessionCount();
      logger.debug('WORKER', 'Processing status broadcast', { isProcessing, queueDepth, activeSessions });

      res.json({ status: 'ok', isProcessing });
    } catch (error) {
      logger.failure('WORKER', 'Failed to broadcast processing status', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
    const project = req.query.project as string | undefined;

    return { offset, limit, project };
  }
}
