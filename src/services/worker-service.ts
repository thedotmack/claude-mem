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
import { readFileSync, writeFileSync, statSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { getPackageRoot } from '../shared/paths.js';
import { getWorkerPort } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  private mcpClient: Client;

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

    // Set callback for when sessions are deleted (to update activity indicator)
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
    }, { capabilities: {} });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(cors());

    // HTTP request/response logging middleware
    this.app.use((req, res, next) => {
      // Skip logging for static assets and health checks
      if (req.path.startsWith('/health') || req.path === '/' || req.path.includes('.')) {
        return next();
      }

      const start = Date.now();
      const requestId = `${req.method}-${Date.now()}`;

      // Log incoming request with body summary
      const bodySummary = this.summarizeRequestBody(req.method, req.path, req.body);
      logger.info('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

      // Capture response
      const originalSend = res.send.bind(res);
      res.send = function(body: any) {
        const duration = Date.now() - start;
        logger.info('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
        return originalSend(body);
      };

      next();
    });

    // Serve static files for web UI (viewer-bundle.js, logos, fonts, etc.)
    const packageRoot = getPackageRoot();
    const uiDir = path.join(packageRoot, 'plugin', 'ui');
    this.app.use(express.static(uiDir));
  }

  /**
   * Summarize request body for logging
   */
  private summarizeRequestBody(method: string, path: string, body: any): string {
    if (!body || Object.keys(body).length === 0) return '';

    // Session init
    if (path.includes('/init')) {
      return '';
    }

    // Observations
    if (path.includes('/observations')) {
      const toolName = body.tool_name || '?';
      const toolInput = body.tool_input;
      const toolSummary = logger.formatTool(toolName, toolInput);
      return `tool=${toolSummary}`;
    }

    // Summarize request
    if (path.includes('/summarize')) {
      return 'requesting summary';
    }

    return '';
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

    // MCP toggle
    this.app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    this.app.post('/api/mcp/toggle', this.handleToggleMcp.bind(this));

    // Search API endpoints (for skill-based search)
    this.app.get('/api/search/observations', this.handleSearchObservations.bind(this));
    this.app.get('/api/search/sessions', this.handleSearchSessions.bind(this));
    this.app.get('/api/search/prompts', this.handleSearchPrompts.bind(this));
    this.app.get('/api/search/by-concept', this.handleSearchByConcept.bind(this));
    this.app.get('/api/search/by-file', this.handleSearchByFile.bind(this));
    this.app.get('/api/search/by-type', this.handleSearchByType.bind(this));
    this.app.get('/api/context/recent', this.handleGetRecentContext.bind(this));
    this.app.get('/api/context/timeline', this.handleGetContextTimeline.bind(this));
    this.app.get('/api/timeline/by-query', this.handleGetTimelineByQuery.bind(this));
    this.app.get('/api/search/help', this.handleSearchHelp.bind(this));
  }

  /**
   * Cleanup orphaned MCP server processes (uvx/chroma) from previous sessions
   */
  private async cleanupOrphanedProcesses(): Promise<void> {
    try {
      const { execSync } = await import('child_process');

      // Find orphaned uvx processes (which spawn chroma servers)
      try {
        const processes = execSync('pgrep -fl uvx', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        if (processes) {
          const processCount = processes.split('\n').length;
          logger.info('WORKER', 'Cleaning up orphaned MCP processes', { count: processCount });

          // Kill the processes
          execSync('pkill -f uvx', { stdio: 'pipe' });
          logger.success('WORKER', `Cleaned up ${processCount} orphaned MCP server processes`);
        }
      } catch (error: any) {
        // pgrep returns exit code 1 if no processes found (not an error)
        if (error.status === 1) {
          logger.debug('WORKER', 'No orphaned MCP processes to clean up');
        } else {
          throw error;
        }
      }
    } catch (error) {
      // Don't fail startup if cleanup fails
      logger.warn('WORKER', 'Failed to cleanup orphaned processes (non-fatal)', {}, error as Error);
    }
  }

  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    // Cleanup orphaned processes from previous sessions
    await this.cleanupOrphanedProcesses();

    // Initialize database (once, stays open)
    await this.dbManager.initialize();

    // Connect to MCP search server
    const searchServerPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'search-server.mjs');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [searchServerPath],
      env: process.env
    });

    await this.mcpClient.connect(transport);
    logger.success('WORKER', 'Connected to MCP search server');

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

    // Close MCP client connection (terminates search server process)
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
        logger.info('SYSTEM', 'MCP client closed');
      } catch (error) {
        logger.error('SYSTEM', 'Failed to close MCP client', {}, error as Error);
      }
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
    }

    // Close database connection (includes ChromaSync cleanup)
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

    // Send initial processing status (based on queue depth + active generators)
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const { userPrompt, promptNumber } = req.body;
      const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

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

        // Start activity indicator immediately when prompt arrives (work is about to begin)
        this.sseBroadcaster.broadcast({
          type: 'processing_status',
          isProcessing: true
        });

        // Sync user prompt to Chroma with error logging
        const chromaStart = Date.now();
        const promptText = latestPrompt.prompt_text;
        this.dbManager.getChromaSync().syncUserPrompt(
          latestPrompt.id,
          latestPrompt.sdk_session_id,
          latestPrompt.project,
          promptText,
          latestPrompt.prompt_number,
          latestPrompt.created_at_epoch
        ).then(() => {
          const chromaDuration = Date.now() - chromaStart;
          const truncatedPrompt = promptText.length > 60
            ? promptText.substring(0, 60) + '...'
            : promptText;
          logger.debug('CHROMA', 'User prompt synced', {
            promptId: latestPrompt.id,
            duration: `${chromaDuration}ms`,
            prompt: truncatedPrompt
          });
        }).catch(err => {
          logger.error('CHROMA', 'Failed to sync user_prompt', {
            promptId: latestPrompt.id,
            sessionId: sessionDbId
          }, err);
        });
      }

      // Broadcast processing status (based on queue depth)
      this.broadcastProcessingStatus();

      // Start SDK agent in background (pass worker ref for spinner control)
      logger.info('SESSION', 'Generator starting', {
        sessionId: sessionDbId,
        project: session.project,
        promptNum: session.lastPromptNumber
      });

      session.generatorPromise = this.sdkAgent.startSession(session, this)
        .catch(err => {
          logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
        })
        .finally(() => {
          // Clear generator reference when completed
          logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
          session.generatorPromise = null;
          // Broadcast status change (generator finished, may stop spinner)
          this.broadcastProcessingStatus();
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
      const { tool_name, tool_input, tool_response, prompt_number, cwd } = req.body;

      this.sessionManager.queueObservation(sessionDbId, {
        tool_name,
        tool_input,
        tool_response,
        prompt_number,
        cwd
      });

      // CRITICAL: Ensure SDK agent is running to consume the queue
      const session = this.sessionManager.getSession(sessionDbId);
      if (session && !session.generatorPromise) {
        logger.info('SESSION', 'Generator auto-starting (observation)', {
          sessionId: sessionDbId,
          queueDepth: session.pendingMessages.length
        });

        session.generatorPromise = this.sdkAgent.startSession(session, this)
          .catch(err => {
            logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
          })
          .finally(() => {
            // Clear generator reference when completed
            logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
            session.generatorPromise = null;
            // Broadcast status change (generator finished, may stop spinner)
            this.broadcastProcessingStatus();
          });
      }

      // Broadcast activity status (queue depth changed)
      this.broadcastProcessingStatus();

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
      const { last_user_message, last_assistant_message } = req.body;

      this.sessionManager.queueSummarize(sessionDbId, last_user_message, last_assistant_message);

      // CRITICAL: Ensure SDK agent is running to consume the queue
      const session = this.sessionManager.getSession(sessionDbId);
      if (session && !session.generatorPromise) {
        logger.info('SESSION', 'Generator auto-starting (summarize)', {
          sessionId: sessionDbId,
          queueDepth: session.pendingMessages.length
        });

        session.generatorPromise = this.sdkAgent.startSession(session, this)
          .catch(err => {
            logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
          })
          .finally(() => {
            // Clear generator reference when completed
            logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
            session.generatorPromise = null;
            // Broadcast status change (generator finished, may stop spinner)
            this.broadcastProcessingStatus();
          });
      }

      // Broadcast activity status (queue depth changed)
      this.broadcastProcessingStatus();

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

      // Broadcast processing status (based on queue depth)
      this.broadcastProcessingStatus();

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
   * Get processing status (for viewer UI spinner and queue indicator)
   */
  private handleGetProcessingStatus(req: Request, res: Response): void {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  }

  // ============================================================================
  // Processing Status Helpers
  // ============================================================================

  /**
   * Broadcast processing status change to SSE clients
   * Checks both queue depth and active generators to prevent premature spinner stop
   */
  broadcastProcessingStatus(): void {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    const activeSessions = this.sessionManager.getActiveSessionCount();

    logger.info('WORKER', 'Broadcasting processing status', {
      isProcessing,
      queueDepth,
      activeSessions
    });

    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
  }

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing(req: Request, res: Response): void {
    try {
      // Broadcast current computed status (ignores manual input)
      this.broadcastProcessingStatus();

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

  // ============================================================================
  // MCP Toggle Handlers
  // ============================================================================

  /**
   * GET /api/mcp/status - Check if MCP search server is enabled
   */
  private handleGetMcpStatus(req: Request, res: Response): void {
    try {
      const enabled = this.isMcpEnabled();
      res.json({ enabled });
    } catch (error) {
      logger.failure('WORKER', 'Get MCP status failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * POST /api/mcp/toggle - Toggle MCP search server on/off
   * Body: { enabled: boolean }
   */
  private handleToggleMcp(req: Request, res: Response): void {
    try {
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }

      this.toggleMcp(enabled);
      res.json({ success: true, enabled: this.isMcpEnabled() });
    } catch (error) {
      logger.failure('WORKER', 'Toggle MCP failed', {}, error as Error);
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  }

  // ============================================================================
  // MCP Toggle Helpers
  // ============================================================================

  /**
   * Check if MCP search server is enabled
   */
  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  /**
   * Toggle MCP search server (rename .mcp.json <-> .mcp.json.disabled)
   */
  private toggleMcp(enabled: boolean): void {
    try {
      const packageRoot = getPackageRoot();
      const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
      const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

      if (enabled && existsSync(mcpDisabledPath)) {
        // Enable: rename .mcp.json.disabled -> .mcp.json
        renameSync(mcpDisabledPath, mcpPath);
        logger.info('WORKER', 'MCP search server enabled');
      } else if (!enabled && existsSync(mcpPath)) {
        // Disable: rename .mcp.json -> .mcp.json.disabled
        renameSync(mcpPath, mcpDisabledPath);
        logger.info('WORKER', 'MCP search server disabled');
      } else {
        logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
      }
    } catch (error) {
      logger.failure('WORKER', 'Failed to toggle MCP', { enabled }, error as Error);
      throw error;
    }
  }

  // ============================================================================
  // Search API Handlers (for skill-based search)
  // ============================================================================

  /**
   * Search observations
   * GET /api/search/observations?query=...&format=index&limit=20&project=...
   */
  private async handleSearchObservations(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_observations',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search session summaries
   * GET /api/search/sessions?query=...&format=index&limit=20
   */
  private async handleSearchSessions(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_sessions',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search user prompts
   * GET /api/search/prompts?query=...&format=index&limit=20
   */
  private async handleSearchPrompts(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_user_prompts',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search observations by concept
   * GET /api/search/by-concept?concept=discovery&format=index&limit=5
   */
  private async handleSearchByConcept(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_concept',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search by file path
   * GET /api/search/by-file?filePath=...&format=index&limit=10
   */
  private async handleSearchByFile(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_file',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search observations by type
   * GET /api/search/by-type?type=bugfix&format=index&limit=10
   */
  private async handleSearchByType(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_type',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get recent context (summaries and observations for a project)
   * GET /api/context/recent?project=...&limit=3
   */
  private async handleGetRecentContext(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_recent_context',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get context timeline around an anchor point
   * GET /api/context/timeline?anchor=123&depth_before=10&depth_after=10&project=...
   */
  private async handleGetContextTimeline(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_context_timeline',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get timeline by query (search first, then get timeline around best match)
   * GET /api/timeline/by-query?query=...&mode=auto&depth_before=10&depth_after=10
   */
  private async handleGetTimelineByQuery(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_timeline_by_query',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get search help documentation
   * GET /api/search/help
   */
  private handleSearchHelp(req: Request, res: Response): void {
    res.json({
      title: 'Claude-Mem Search API',
      description: 'HTTP API for searching persistent memory',
      endpoints: [
        {
          path: '/api/search/observations',
          method: 'GET',
          description: 'Search observations using full-text search',
          parameters: {
            query: 'Search query (required)',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 20)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/sessions',
          method: 'GET',
          description: 'Search session summaries using full-text search',
          parameters: {
            query: 'Search query (required)',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 20)'
          }
        },
        {
          path: '/api/search/prompts',
          method: 'GET',
          description: 'Search user prompts using full-text search',
          parameters: {
            query: 'Search query (required)',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 20)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-concept',
          method: 'GET',
          description: 'Find observations by concept tag',
          parameters: {
            concept: 'Concept tag (required): discovery, decision, bugfix, feature, refactor',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-file',
          method: 'GET',
          description: 'Find observations and sessions by file path',
          parameters: {
            filePath: 'File path or partial path (required)',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results per type (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-type',
          method: 'GET',
          description: 'Find observations by type',
          parameters: {
            type: 'Observation type (required): discovery, decision, bugfix, feature, refactor',
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/context/recent',
          method: 'GET',
          description: 'Get recent session context including summaries and observations',
          parameters: {
            project: 'Project name (default: current directory)',
            limit: 'Number of recent sessions (default: 3)'
          }
        },
        {
          path: '/api/context/timeline',
          method: 'GET',
          description: 'Get unified timeline around a specific point in time',
          parameters: {
            anchor: 'Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp (required)',
            depth_before: 'Number of records before anchor (default: 10)',
            depth_after: 'Number of records after anchor (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/timeline/by-query',
          method: 'GET',
          description: 'Search for best match, then get timeline around it',
          parameters: {
            query: 'Search query (required)',
            mode: 'Search mode: "auto", "observations", or "sessions" (default: "auto")',
            depth_before: 'Number of records before match (default: 10)',
            depth_after: 'Number of records after match (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/help',
          method: 'GET',
          description: 'Get this help documentation'
        }
      ],
      examples: [
        'curl "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"',
        'curl "http://localhost:37777/api/search/by-type?type=bugfix&limit=10"',
        'curl "http://localhost:37777/api/context/recent?project=claude-mem&limit=3"',
        'curl "http://localhost:37777/api/context/timeline?anchor=123&depth_before=5&depth_after=5"'
      ]
    });
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
