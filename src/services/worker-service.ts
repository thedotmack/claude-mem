/**
 * Worker Service - Slim Orchestrator
 *
 * Refactored from 2000-line monolith to ~150-line orchestrator.
 * Routes organized by domain in http/routes/*.ts
 * See src/services/worker/README.md for architecture details.
 */

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

  // Route handlers
  private viewerRoutes: ViewerRoutes;
  private sessionRoutes: SessionRoutes;
  private dataRoutes: DataRoutes;
  private searchRoutes: SearchRoutes;
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

    // Set callback for when sessions are deleted (to update activity indicator)
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // Initialize MCP client
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
    }, { capabilities: {} });

    // Initialize route handlers
    this.viewerRoutes = new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager);
    this.sessionRoutes = new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.sseBroadcaster, this);
    this.dataRoutes = new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime);
    this.searchRoutes = new SearchRoutes(this.mcpClient);
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
    this.viewerRoutes.setupRoutes(this.app);
    this.sessionRoutes.setupRoutes(this.app);
    this.dataRoutes.setupRoutes(this.app);
    this.searchRoutes.setupRoutes(this.app);
    this.settingsRoutes.setupRoutes(this.app);
  }

  /**
   * Cleanup orphaned MCP server processes (uvx/chroma) from previous sessions
   */
  private async cleanupOrphanedProcesses(): Promise<void> {
    try {
      const { execSync } = await import('child_process');

      // Find orphaned uvx processes (which spawn chroma servers)
      try {
        const processes = execSync('pgrep -fl uvx', { encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();
        if (processes) {
          const processCount = processes.split('\n').length;
          logger.info('WORKER', 'Cleaning up orphaned MCP processes', { count: processCount });

          // Kill the processes
          execSync('pkill -f uvx', { stdio: 'pipe', windowsHide: true });
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
    const searchServerPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'search-server.cjs');
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
