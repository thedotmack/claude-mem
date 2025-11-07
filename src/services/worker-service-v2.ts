/**
 * Worker Service v2: Clean Object-Oriented Architecture
 *
 * This is a complete rewrite following the architecture document.
 * Key improvements:
 * - Single database connection (no open/close churn)
 * - Event-driven queues (zero polling)
 * - DRY utilities for pagination and settings
 * - Clean separation of concerns
 * - ~600-700 lines (down from 1173)
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { getPackageRoot } from '../shared/paths.js';
import { getWorkerPort } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

// Import composed services
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';

export class WorkerService {
  private app: express.Application;
  private server: http.Server | null = null;

  // Composed services
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;

  constructor() {
    this.app = express();

    // Initialize services (dependency injection)
    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);
    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(cors());
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    // Health & Viewer
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/', this.handleViewerUI.bind(this));
    this.app.get('/stream', this.handleSSEStream.bind(this));

    // Session endpoints
    this.app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    this.app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    this.app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    this.app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    this.app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    this.app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // Data retrieval
    this.app.get('/api/observations', this.handleGetObservations.bind(this));
    this.app.get('/api/summaries', this.handleGetSummaries.bind(this));
    this.app.get('/api/prompts', this.handleGetPrompts.bind(this));
    this.app.get('/api/stats', this.handleGetStats.bind(this));

    // Settings
    this.app.get('/api/settings', this.handleGetSettings.bind(this));
    this.app.post('/api/settings', this.handleUpdateSettings.bind(this));
  }

  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    // Initialize database (once, stays open)
    await this.dbManager.initialize();

    // Cleanup orphaned sessions from previous runs
    const cleaned = this.dbManager.cleanupOrphanedSessions();
    if (cleaned > 0) {
      logger.info('SYSTEM', `Cleaned ${cleaned} orphaned sessions`);
    }

    // Start HTTP server
    const port = getWorkerPort();
    this.server = await new Promise<http.Server>((resolve, reject) => {
      const srv = this.app.listen(port, () => resolve(srv));
      srv.on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { port, pid: process.pid });
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
    // Shutdown all active sessions
    await this.sessionManager.shutdownAll();

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
    }

    // Close database connection
    await this.dbManager.close();

    logger.info('SYSTEM', 'Worker shutdown complete');
  }

  // ============================================================================
  // Route Handlers
  // ============================================================================

  /**
   * Health check endpoint
   */
  private handleHealth(req: Request, res: Response): void {
    res.json({ status: 'ok', timestamp: Date.now() });
  }

  /**
   * Serve viewer UI
   */
  private handleViewerUI(req: Request, res: Response): void {
    try {
      const packageRoot = getPackageRoot();
      const viewerPath = path.join(packageRoot, 'plugin', 'ui', 'viewer.html');
      const html = readFileSync(viewerPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      logger.failure('WORKER', 'Viewer UI error', {}, error as Error);
      res.status(500).json({ error: 'Failed to load viewer UI' });
    }
  }

  /**
   * SSE stream endpoint
   */
  private handleSSEStream(req: Request, res: Response): void {
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const session = this.sessionManager.initializeSession(sessionDbId);

      // Start SDK agent in background
      this.sdkAgent.startSession(session).catch(err => {
        logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
      });

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_started',
        sessionDbId,
        project: session.project
      });

      res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
    } catch (error) {
      logger.failure('WORKER', 'Session init failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Queue observations for processing
   */
  private handleObservations(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const { tool_name, tool_input, tool_response, prompt_number } = req.body;

      this.sessionManager.queueObservation(sessionDbId, {
        tool_name,
        tool_input,
        tool_response,
        prompt_number
      });

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'observation_queued',
        sessionDbId
      });

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Observation queuing failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Queue summarize request
   */
  private handleSummarize(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      this.sessionManager.queueSummarize(sessionDbId);

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Summarize queuing failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get session status
   */
  private handleSessionStatus(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const session = this.sessionManager.getSession(sessionDbId);

      if (!session) {
        res.json({ status: 'not_found' });
        return;
      }

      res.json({
        status: 'active',
        sessionDbId,
        project: session.project,
        queueLength: session.pendingMessages.length,
        uptime: Date.now() - session.startTime
      });
    } catch (error) {
      logger.failure('WORKER', 'Session status failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Delete a session
   */
  private async handleSessionDelete(req: Request, res: Response): Promise<void> {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      await this.sessionManager.deleteSession(sessionDbId);

      // Mark session complete in database
      this.dbManager.markSessionComplete(sessionDbId);

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_completed',
        sessionDbId
      });

      res.json({ status: 'deleted' });
    } catch (error) {
      logger.failure('WORKER', 'Session delete failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Complete a session (backward compatibility for cleanup-hook)
   * cleanup-hook expects POST /sessions/:sessionDbId/complete instead of DELETE
   */
  private async handleSessionComplete(req: Request, res: Response): Promise<void> {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      if (isNaN(sessionDbId)) {
        res.status(400).json({ success: false, error: 'Invalid session ID' });
        return;
      }

      await this.sessionManager.deleteSession(sessionDbId);

      // Mark session complete in database
      this.dbManager.markSessionComplete(sessionDbId);

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_completed',
        timestamp: Date.now(),
        sessionDbId
      });

      res.json({ success: true });
    } catch (error) {
      logger.failure('WORKER', 'Session complete failed', {}, error as Error);
      res.status(500).json({ success: false, error: String(error) });
    }
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations(req: Request, res: Response): void {
    try {
      const { offset, limit, project } = parsePaginationParams(req);
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
      const { offset, limit, project } = parsePaginationParams(req);
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
      const { offset, limit, project } = parsePaginationParams(req);
      const result = this.paginationHelper.getPrompts(offset, limit, project);
      res.json(result);
    } catch (error) {
      logger.failure('WORKER', 'Get prompts failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get database statistics
   */
  private handleGetStats(req: Request, res: Response): void {
    try {
      const db = this.dbManager.getSessionStore().db;

      // Get total counts
      const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      const totalPrompts = db.prepare('SELECT COUNT(*) as count FROM user_prompts').get() as { count: number };
      const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM summaries').get() as { count: number };

      // Get project counts
      const projectCounts: Record<string, any> = {};

      const projects = db.prepare('SELECT DISTINCT project FROM observations').all() as Array<{ project: string }>;

      for (const { project } of projects) {
        const obsCount = db.prepare('SELECT COUNT(*) as count FROM observations WHERE project = ?').get(project) as { count: number };
        const sessCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project = ?').get(project) as { count: number };
        const promptCount = db.prepare('SELECT COUNT(*) as count FROM user_prompts WHERE project = ?').get(project) as { count: number };
        const summCount = db.prepare('SELECT COUNT(*) as count FROM summaries WHERE project = ?').get(project) as { count: number };

        projectCounts[project] = {
          observations: obsCount.count,
          sessions: sessCount.count,
          prompts: promptCount.count,
          summaries: summCount.count
        };
      }

      res.json({
        totalObservations: totalObservations.count,
        totalSessions: totalSessions.count,
        totalPrompts: totalPrompts.count,
        totalSummaries: totalSummaries.count,
        projectCounts
      });
    } catch (error) {
      logger.failure('WORKER', 'Get stats failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get viewer settings
   */
  private handleGetSettings(req: Request, res: Response): void {
    try {
      const settings = this.settingsManager.getSettings();
      res.json(settings);
    } catch (error) {
      logger.failure('WORKER', 'Get settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Update viewer settings
   */
  private handleUpdateSettings(req: Request, res: Response): void {
    try {
      const updates = req.body;
      const settings = this.settingsManager.updateSettings(updates);
      res.json(settings);
    } catch (error) {
      logger.failure('WORKER', 'Update settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Parse pagination parameters from request
 */
function parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
  const offset = parseInt(req.query.offset as string, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
  const project = req.query.project as string | undefined;

  return { offset, limit, project };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Start the worker service (if running as main module)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = new WorkerService();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SYSTEM', 'Received SIGTERM, shutting down gracefully');
    await worker.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SYSTEM', 'Received SIGINT, shutting down gracefully');
    await worker.shutdown();
    process.exit(0);
  });

  // Start the worker
  worker.start().catch(error => {
    logger.failure('SYSTEM', 'Worker startup failed', {}, error);
    process.exit(1);
  });
}

export default WorkerService;
