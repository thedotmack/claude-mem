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
import { readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
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
  private startTime: number = Date.now();

  // Composed services
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;

  // Processing status tracking for viewer UI spinner
  private isProcessing: boolean = false;

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

    // Serve static files for web UI (viewer-bundle.js, logos, fonts, etc.)
    const packageRoot = getPackageRoot();
    const uiDir = path.join(packageRoot, 'plugin', 'ui');
    this.app.use(express.static(uiDir));
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
    this.app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    this.app.post('/api/processing', this.handleSetProcessing.bind(this));

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

    // Send initial_load event with projects list
    const allProjects = this.dbManager.getSessionStore().getAllProjects();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: allProjects,
      timestamp: Date.now()
    });

    // Send initial processing status
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing: this.isProcessing
    });
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const session = this.sessionManager.initializeSession(sessionDbId);

      // Get the latest user_prompt for this session to sync to Chroma
      const db = this.dbManager.getSessionStore().db;
      const latestPrompt = db.prepare(`
        SELECT
          up.*,
          s.sdk_session_id,
          s.project
        FROM user_prompts up
        JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
        WHERE up.claude_session_id = ?
        ORDER BY up.created_at_epoch DESC
        LIMIT 1
      `).get(session.claudeSessionId) as any;

      // Broadcast new prompt to SSE clients (for web UI)
      if (latestPrompt) {
        this.sseBroadcaster.broadcast({
          type: 'new_prompt',
          prompt: {
            id: latestPrompt.id,
            claude_session_id: latestPrompt.claude_session_id,
            project: latestPrompt.project,
            prompt_number: latestPrompt.prompt_number,
            prompt_text: latestPrompt.prompt_text,
            created_at_epoch: latestPrompt.created_at_epoch
          }
        });

        // Sync user prompt to Chroma (fire-and-forget)
        this.dbManager.getChromaSync().syncUserPrompt(
          latestPrompt.id,
          latestPrompt.sdk_session_id,
          latestPrompt.project,
          latestPrompt.prompt_text,
          latestPrompt.prompt_number,
          latestPrompt.created_at_epoch
        ).catch(err => {
          logger.error('WORKER', 'Failed to sync user_prompt to Chroma', { promptId: latestPrompt.id }, err);
        });
      }

      // Start processing indicator
      this.broadcastProcessingStatus(true);

      // Start SDK agent in background (pass worker ref for spinner control)
      this.sdkAgent.startSession(session, this).catch(err => {
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
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
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

      // CRITICAL: Ensure SDK agent is running to consume the queue
      const session = this.sessionManager.getSession(sessionDbId);
      if (session && !session.generatorPromise) {
        session.generatorPromise = this.sdkAgent.startSession(session, this).catch(err => {
          logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
        });
      }

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
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleSummarize(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      this.sessionManager.queueSummarize(sessionDbId);

      // CRITICAL: Ensure SDK agent is running to consume the queue
      const session = this.sessionManager.getSession(sessionDbId);
      if (session && !session.generatorPromise) {
        session.generatorPromise = this.sdkAgent.startSession(session, this).catch(err => {
          logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
        });
      }

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

      // Stop processing indicator
      this.broadcastProcessingStatus(false);

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
   * Get environment settings (from ~/.claude/settings.json)
   */
  private handleGetSettings(req: Request, res: Response): void {
    try {
      const settingsPath = path.join(homedir(), '.claude', 'settings.json');

      if (!existsSync(settingsPath)) {
        // Return defaults if file doesn't exist
        res.json({
          CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
          CLAUDE_MEM_WORKER_PORT: '37777'
        });
        return;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);
      const env = settings.env || {};

      res.json({
        CLAUDE_MEM_MODEL: env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50',
        CLAUDE_MEM_WORKER_PORT: env.CLAUDE_MEM_WORKER_PORT || '37777'
      });
    } catch (error) {
      logger.failure('WORKER', 'Get settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Update environment settings (in ~/.claude/settings.json) with validation
   */
  private handleUpdateSettings(req: Request, res: Response): void {
    try {
      const { CLAUDE_MEM_MODEL, CLAUDE_MEM_CONTEXT_OBSERVATIONS, CLAUDE_MEM_WORKER_PORT } = req.body;

      // Validate inputs
      if (CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
        const obsCount = parseInt(CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
        if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
          res.status(400).json({
            success: false,
            error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200'
          });
          return;
        }
      }

      if (CLAUDE_MEM_WORKER_PORT) {
        const port = parseInt(CLAUDE_MEM_WORKER_PORT, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          res.status(400).json({
            success: false,
            error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535'
          });
          return;
        }
      }

      // Read existing settings
      const settingsPath = path.join(homedir(), '.claude', 'settings.json');
      let settings: any = { env: {} };

      if (existsSync(settingsPath)) {
        const settingsData = readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(settingsData);
        if (!settings.env) {
          settings.env = {};
        }
      }

      // Update settings
      if (CLAUDE_MEM_MODEL) {
        settings.env.CLAUDE_MEM_MODEL = CLAUDE_MEM_MODEL;
      }
      if (CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
        settings.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS = CLAUDE_MEM_CONTEXT_OBSERVATIONS;
      }
      if (CLAUDE_MEM_WORKER_PORT) {
        settings.env.CLAUDE_MEM_WORKER_PORT = CLAUDE_MEM_WORKER_PORT;
      }

      // Write back
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      logger.info('WORKER', 'Settings updated');
      res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
      logger.failure('WORKER', 'Update settings failed', {}, error as Error);
      res.status(500).json({ success: false, error: String(error) });
    }
  }

  /**
   * Get processing status (for viewer UI spinner)
   */
  private handleGetProcessingStatus(req: Request, res: Response): void {
    res.json({ isProcessing: this.isProcessing });
  }

  // ============================================================================
  // Processing Status Helpers
  // ============================================================================

  /**
   * Broadcast processing status change to SSE clients
   */
  broadcastProcessingStatus(isProcessing: boolean): void {
    this.isProcessing = isProcessing;
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing
    });
  }

  /**
   * Set processing status (called by hooks)
   */
  private handleSetProcessing(req: Request, res: Response): void {
    try {
      const { isProcessing } = req.body;

      if (typeof isProcessing !== 'boolean') {
        res.status(400).json({ error: 'isProcessing must be a boolean' });
        return;
      }

      this.broadcastProcessingStatus(isProcessing);
      logger.debug('WORKER', 'Processing status updated', { isProcessing });

      res.json({ status: 'ok', isProcessing });
    } catch (error) {
      logger.failure('WORKER', 'Failed to set processing status', {}, error as Error);
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
 * Note: Using require.main check for CJS compatibility (build outputs CJS)
 */
if (require.main === module || !module.parent) {
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
