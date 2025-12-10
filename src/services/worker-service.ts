/**
 * Worker Service - Slim Orchestrator
 *
 * Refactored from 2000-line monolith to ~150-line orchestrator.
 * Routes organized by domain in http/routes/*.ts
 * See src/services/worker/README.md for architecture details.
 */

/**
 * Windows terminal window fix for MCP SDK (vX.Y.Z):
 * The MCP SDK checks `process.type === 'renderer'` (Electron detection) before setting windowsHide.
 * By setting process.type, the SDK's isElectron() check becomes truthy on Windows, hiding
 * terminal windows when spawning uvx/python processes for Chroma MCP server.
 * The type is sometimes not present resulting in the check being false. Setting it like this fixes it.
 *
 * TODO: Remove this workaround once MCP SDK exposes a config for windowsHide or fixes detection.
 * See: https://github.com/modelcontextprotocol/sdk/issues/XXX
 */
function applyWindowsHideWorkaroundIfNeeded() {
  if (process.platform === 'win32' && !process.type) {
    // Optionally, check MCP SDK version here if available
    // Log a warning so this is visible in logs
    // eslint-disable-next-line no-console
    console.warn(
      '[worker-service] Applying MCP SDK windowsHide workaround: setting process.type = "renderer". ' +
      'This is a fragile hack. Remove when MCP SDK is fixed. See code comments for details.'
    );
    (process as any).type = 'renderer';
  }
}

applyWindowsHideWorkaroundIfNeeded();
import express from 'express';
import http from 'http';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

// Import composed domain services
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';
import { SearchManager } from './worker/SearchManager.js';
import { FormattingService } from './worker/FormattingService.js';
import { TimelineService } from './worker/TimelineService.js';
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';

// Import HTTP layer
import { createMiddleware, summarizeRequestBody as summarizeBody } from './worker/http/middleware.js';
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';

export class WorkerService {
  private app: express.Application;
  private server: http.Server | null = null;
  private startTime: number = Date.now();
  private mcpClient: Client;

  // Domain services
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
  private sessionEventBroadcaster: SessionEventBroadcaster;

  // Route handlers
  private viewerRoutes: ViewerRoutes;
  private sessionRoutes: SessionRoutes;
  private dataRoutes: DataRoutes;
  private searchRoutes: SearchRoutes | null;
  private settingsRoutes: SettingsRoutes;

  constructor() {
    this.app = express();

    // Initialize domain services
    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);
    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);

    // Set callback for when sessions are deleted (to update activity indicator)
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // Initialize MCP client
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
    }, { capabilities: {} });

    // Initialize route handlers (SearchRoutes will use MCP client initially, then switch to SearchManager after DB init)
    this.viewerRoutes = new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager);
    this.sessionRoutes = new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.sessionEventBroadcaster, this);
    this.dataRoutes = new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime);
    // SearchRoutes needs SearchManager which requires initialized DB - will be created in initializeBackground()
    this.searchRoutes = null;
    this.settingsRoutes = new SettingsRoutes(this.settingsManager);

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    const middlewares = createMiddleware(this.summarizeRequestBody.bind(this));
    middlewares.forEach(mw => this.app.use(mw));
  }

  /**
   * Setup HTTP routes (delegate to route classes)
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/api/health', (_req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    this.viewerRoutes.setupRoutes(this.app);
    this.sessionRoutes.setupRoutes(this.app);
    this.dataRoutes.setupRoutes(this.app);
    // searchRoutes is set up after database initialization in initializeBackground()
    this.settingsRoutes.setupRoutes(this.app);
  }


  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    // Start HTTP server FIRST - make port available immediately
    const port = getWorkerPort();
    this.server = await new Promise<http.Server>((resolve, reject) => {
      const srv = this.app.listen(port, () => resolve(srv));
      srv.on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { port, pid: process.pid });

    // Do slow initialization in background (non-blocking)
    this.initializeBackground().catch((error) => {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
    });
  }

  /**
   * Background initialization - runs after HTTP server is listening
   */
  private async initializeBackground(): Promise<void> {
    // Initialize database (once, stays open)
    await this.dbManager.initialize();

    // Initialize search services (requires initialized database)
    const formattingService = new FormattingService();
    const timelineService = new TimelineService();
    const searchManager = new SearchManager(
      this.dbManager.getSessionSearch(),
      this.dbManager.getSessionStore(),
      this.dbManager.getChromaSync(),
      formattingService,
      timelineService
    );
    this.searchRoutes = new SearchRoutes(searchManager);
    this.searchRoutes.setupRoutes(this.app); // Setup search routes now that SearchManager is ready
    logger.info('WORKER', 'SearchManager initialized and search routes registered');

    // Connect to MCP server
    const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerPath],
      env: process.env
    });

    await this.mcpClient.connect(transport);
    logger.success('WORKER', 'Connected to MCP server');
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
    // Shutdown all active sessions
    await this.sessionManager.shutdownAll();

    // Close MCP client connection (terminates MCP server process)
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

  /**
   * Summarize request body for logging
   * Used to avoid logging sensitive data or large payloads
   */
  private summarizeRequestBody(method: string, path: string, body: any): string {
    return summarizeBody(method, path, body);
  }

  /**
   * Broadcast processing status change to SSE clients
   * Checks both queue depth and active generators to prevent premature spinner stop
   *
   * PUBLIC: Called by route handlers (SessionRoutes, DataRoutes)
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

  worker.start().catch((error) => {
    logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
    process.exit(1);
  });
}
