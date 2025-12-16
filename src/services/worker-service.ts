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
import * as fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

  // Initialization tracking
  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

  constructor() {
    this.app = express();

    // Initialize the promise that will resolve when background initialization completes
    this.initializationComplete = new Promise((resolve) => {
      this.resolveInitialization = resolve;
    });

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

    // Version endpoint - returns the worker's current version
    this.app.get('/api/version', (_req, res) => {
      try {
        // Read version from marketplace package.json
        const { homedir } = require('os');
        const { readFileSync } = require('fs');
        const marketplaceRoot = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
        const packageJsonPath = path.join(marketplaceRoot, 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        res.status(200).json({ version: packageJson.version });
      } catch (error) {
        logger.error('SYSTEM', 'Failed to read version', {
          packagePath: packageJsonPath
        }, error as Error);
        res.status(500).json({
          error: 'Failed to read version',
          path: packageJsonPath
        });
      }
    });

    // Instructions endpoint - loads SKILL.md sections on-demand for progressive instruction loading
    this.app.get('/api/instructions', async (req, res) => {
      const topic = (req.query.topic as string) || 'all';
      // Read SKILL.md from plugin directory
      // Path resolution: __dirname is build output directory (plugin/scripts/)
      // SKILL.md is at plugin/skills/mem-search/SKILL.md
      const skillPath = path.join(__dirname, '../skills/mem-search/SKILL.md');

      try {
        const fullContent = await fs.promises.readFile(skillPath, 'utf-8');

        // Extract section based on topic
        const section = this.extractInstructionSection(fullContent, topic);

        // Return in MCP format
        res.json({
          content: [{
            type: 'text',
            text: section
          }]
        });
      } catch (error) {
        logger.error('WORKER', 'Failed to load instructions', { topic, skillPath }, error as Error);
        res.status(500).json({
          content: [{
            type: 'text',
            text: `Error loading instructions: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        });
      }
    });

    // Admin endpoints for process management
    this.app.post('/api/admin/restart', async (_req, res) => {
      res.json({ status: 'restarting' });
      setTimeout(async () => {
        await this.shutdown();
        process.exit(0);
      }, 100);
    });

    this.app.post('/api/admin/shutdown', async (_req, res) => {
      res.json({ status: 'shutting_down' });
      setTimeout(async () => {
        await this.shutdown();
        process.exit(0);
      }, 100);
    });

    this.viewerRoutes.setupRoutes(this.app);
    this.sessionRoutes.setupRoutes(this.app);
    this.dataRoutes.setupRoutes(this.app);
    // searchRoutes is set up after database initialization in initializeBackground()
    this.settingsRoutes.setupRoutes(this.app);

    // Register early handler for /api/context/inject to avoid 404 during startup
    // This handler waits for initialization to complete before delegating to SearchRoutes
    // NOTE: This duplicates logic from SearchRoutes.handleContextInject by design,
    // as we need the route available immediately before SearchRoutes is initialized
    this.app.get('/api/context/inject', async (req, res, next) => {
      try {
        // Wait for initialization to complete (with timeout)
        const timeoutMs = 30000; // 30 second timeout
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
        );
        
        await Promise.race([this.initializationComplete, timeoutPromise]);

        // If searchRoutes is still null after initialization, something went wrong
        if (!this.searchRoutes) {
          res.status(503).json({ error: 'Search routes not initialized' });
          return;
        }

        // Delegate to the proper handler by re-processing the request
        // Since we're already in the middleware chain, we need to call the handler directly
        const projectName = req.query.project as string;
        const useColors = req.query.colors === 'true';

        if (!projectName) {
          res.status(400).json({ error: 'Project parameter is required' });
          return;
        }

        // Import context generator (runs in worker, has access to database)
        const { generateContext } = await import('./context-generator.js');

        // Use project name as CWD (generateContext uses path.basename to get project)
        const cwd = `/context/${projectName}`;

        // Generate context
        const contextText = await generateContext(
          {
            session_id: 'context-inject-' + Date.now(),
            cwd: cwd
          },
          useColors
        );

        // Return as plain text
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(contextText);
      } catch (error) {
        logger.error('WORKER', 'Context inject handler failed', {}, error as Error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
      }
    });
  }


  /**
   * Clean up orphaned chroma-mcp processes from previous worker sessions
   * Prevents process accumulation and memory leaks
   */
  private async cleanupOrphanedProcesses(): Promise<void> {
    try {
      // Find all chroma-mcp processes
      const { stdout } = await execAsync('ps aux | grep "chroma-mcp" | grep -v grep || true');

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found');
        return;
      }

      const lines = stdout.trim().split('\n');
      const pids: number[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 1) {
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid)) {
            pids.push(pid);
          }
        }
      }

      if (pids.length === 0) {
        return;
      }

      logger.info('SYSTEM', 'Cleaning up orphaned chroma-mcp processes', {
        count: pids.length,
        pids
      });

      // Kill all found processes
      await execAsync(`kill ${pids.join(' ')}`);

      logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: pids.length });
    } catch (error) {
      // Non-fatal - log and continue
      logger.warn('SYSTEM', 'Failed to cleanup orphaned processes', {}, error as Error);
    }
  }

  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    // Start HTTP server FIRST - make port available immediately
    const port = getWorkerPort();
    const host = getWorkerHost();
    this.server = await new Promise<http.Server>((resolve, reject) => {
      const srv = this.app.listen(port, host, () => resolve(srv));
      srv.on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { host, port, pid: process.pid });

    // Do slow initialization in background (non-blocking)
    this.initializeBackground().catch((error) => {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
    });
  }

  /**
   * Background initialization - runs after HTTP server is listening
   */
  private async initializeBackground(): Promise<void> {
    try {
      // Clean up any orphaned chroma-mcp processes BEFORE starting our own
      await this.cleanupOrphanedProcesses();

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

      // Signal that initialization is complete
      this.resolveInitialization();
      logger.info('SYSTEM', 'Background initialization complete');
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      // Still resolve to prevent hanging requests, but they'll see searchRoutes is null
      this.resolveInitialization();
      throw error;
    }
  }

  /**
   * Extract a specific section from instruction content
   * Used by /api/instructions endpoint for progressive instruction loading
   */
  private extractInstructionSection(content: string, topic: string): string {
    const sections: Record<string, string> = {
      'workflow': this.extractBetween(content, '## The Workflow', '## Search Parameters'),
      'search_params': this.extractBetween(content, '## Search Parameters', '## Examples'),
      'examples': this.extractBetween(content, '## Examples', '## Why This Workflow'),
      'all': content
    };

    return sections[topic] || sections['all'];
  }

  /**
   * Extract text between two markers
   * Helper for extractInstructionSection
   */
  private extractBetween(content: string, startMarker: string, endMarker: string): string {
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx === -1) return content;
    if (endIdx === -1) return content.substring(startIdx);

    return content.substring(startIdx, endIdx).trim();
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
    const isPortError = error?.code === 'EADDRINUSE' || 
                        (error?.message?.includes('EADDRINUSE') ||
                        error?.message?.includes('address already in use'));
    
    if (isPortError) {
      const port = getWorkerPort();
      logger.failure('SYSTEM', `Failed to start server. Is port ${port} in use?`, { port, error: error?.message });
    } else {
      logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
    }
    process.exit(1);
  });
}
