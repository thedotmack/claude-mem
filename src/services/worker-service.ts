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
import { exec, execSync } from 'child_process';
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
import { createMiddleware, summarizeRequestBody as summarizeBody, requireLocalhost } from './worker/http/middleware.js';
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

  // Initialization flags for MCP/SDK readiness tracking
  private mcpReady: boolean = false;
  private initializationCompleteFlag: boolean = false;

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
    // TEST_BUILD_ID helps verify which build is running during debugging
    const TEST_BUILD_ID = 'TEST-008-wrapper-ipc';
    this.app.get('/api/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        build: TEST_BUILD_ID,
        managed: process.env.CLAUDE_MEM_MANAGED === 'true',
        hasIpc: typeof process.send === 'function',
        platform: process.platform,
        pid: process.pid,
        initialized: this.initializationCompleteFlag,
        mcpReady: this.mcpReady,
      });
    });

    // Readiness check endpoint - returns 503 until full initialization completes
    // Used by ProcessManager and worker-utils to ensure worker is fully ready before routing requests
    this.app.get('/api/readiness', (_req, res) => {
      if (this.initializationCompleteFlag) {
        res.status(200).json({
          status: 'ready',
          mcpReady: this.mcpReady,
        });
      } else {
        res.status(503).json({
          status: 'initializing',
          message: 'Worker is still initializing, please retry',
        });
      }
    });

    // Version endpoint - returns the worker's current version
    this.app.get('/api/version', (_req, res) => {
      const { homedir } = require('os');
      const { readFileSync } = require('fs');
      const marketplaceRoot = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
      const packageJsonPath = path.join(marketplaceRoot, 'package.json');

      try {
        // Read version from marketplace package.json
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

    // Admin endpoints for process management (localhost-only)
    this.app.post('/api/admin/restart', requireLocalhost, async (_req, res) => {
      res.json({ status: 'restarting' });

      // On Windows, if managed by wrapper, send message to parent to handle restart
      // This solves the Windows zombie port problem where sockets aren't properly released
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        logger.info('SYSTEM', 'Sending restart request to wrapper');
        process.send!({ type: 'restart' });
      } else {
        // Unix or standalone Windows - handle restart ourselves
        setTimeout(async () => {
          await this.shutdown();
          process.exit(0);
        }, 100);
      }
    });

    this.app.post('/api/admin/shutdown', requireLocalhost, async (_req, res) => {
      res.json({ status: 'shutting_down' });

      // On Windows, if managed by wrapper, send message to parent to handle shutdown
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        logger.info('SYSTEM', 'Sending shutdown request to wrapper');
        process.send!({ type: 'shutdown' });
      } else {
        // Unix or standalone Windows - handle shutdown ourselves
        setTimeout(async () => {
          await this.shutdown();
          process.exit(0);
        }, 100);
      }
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
      const isWindows = process.platform === 'win32';
      const pids: number[] = [];

      if (isWindows) {
        // Windows: Use PowerShell Get-CimInstance to find chroma-mcp processes
        const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
        const { stdout } = await execAsync(cmd, { timeout: 5000 });

        if (!stdout.trim()) {
          logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Windows)');
          return;
        }

        const pidStrings = stdout.trim().split('\n');
        for (const pidStr of pidStrings) {
          const pid = parseInt(pidStr.trim(), 10);
          // SECURITY: Validate PID is positive integer before adding to list
          if (!isNaN(pid) && Number.isInteger(pid) && pid > 0) {
            pids.push(pid);
          }
        }
      } else {
        // Unix: Use ps aux | grep
        const { stdout } = await execAsync('ps aux | grep "chroma-mcp" | grep -v grep || true');

        if (!stdout.trim()) {
          logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Unix)');
          return;
        }

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 1) {
            const pid = parseInt(parts[1], 10);
            // SECURITY: Validate PID is positive integer before adding to list
            if (!isNaN(pid) && Number.isInteger(pid) && pid > 0) {
              pids.push(pid);
            }
          }
        }
      }

      if (pids.length === 0) {
        return;
      }

      logger.info('SYSTEM', 'Cleaning up orphaned chroma-mcp processes', {
        platform: isWindows ? 'Windows' : 'Unix',
        count: pids.length,
        pids
      });

      // Kill all found processes
      if (isWindows) {
        for (const pid of pids) {
          // SECURITY: Double-check PID validation before using in taskkill command
          if (!Number.isInteger(pid) || pid <= 0) {
            logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
            continue;
          }
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, stdio: 'ignore' });
          } catch (error) {
            logger.warn('SYSTEM', 'Failed to kill orphaned process', { pid }, error as Error);
          }
        }
      } else {
        await execAsync(`kill ${pids.join(' ')}`);
      }

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

      // Connect to MCP server with timeout guard
      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env: process.env
      });

      // Add timeout guard to prevent hanging on MCP connection (15 seconds)
      const MCP_INIT_TIMEOUT_MS = 15000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timeout after 15s')), MCP_INIT_TIMEOUT_MS)
      );

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      // Signal that initialization is complete
      this.initializationCompleteFlag = true;
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
   *
   * IMPORTANT: On Windows, we must kill all child processes before exiting
   * to prevent zombie ports. The socket handle can be inherited by children,
   * and if not properly closed, the port stays bound after process death.
   */
  async shutdown(): Promise<void> {
    logger.info('SYSTEM', 'Shutdown initiated');

    // STEP 1: Enumerate all child processes BEFORE we start closing things
    const childPids = await this.getChildProcesses(process.pid);
    logger.info('SYSTEM', 'Found child processes', { count: childPids.length, pids: childPids });

    // STEP 2: Close HTTP server first
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
      this.server = null;
      logger.info('SYSTEM', 'HTTP server closed');
    }

    // STEP 3: Shutdown active sessions
    await this.sessionManager.shutdownAll();

    // STEP 4: Close MCP client connection (signals child to exit gracefully)
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
        logger.info('SYSTEM', 'MCP client closed');
      } catch (error) {
        logger.error('SYSTEM', 'Failed to close MCP client', {}, error as Error);
      }
    }

    // STEP 5: Close database connection (includes ChromaSync cleanup)
    await this.dbManager.close();

    // STEP 6: Force kill any remaining child processes (Windows zombie port fix)
    if (childPids.length > 0) {
      logger.info('SYSTEM', 'Force killing remaining children');
      for (const pid of childPids) {
        await this.forceKillProcess(pid);
      }
      // Wait for children to fully exit
      await this.waitForProcessesExit(childPids, 5000);
    }

    logger.info('SYSTEM', 'Worker shutdown complete');
  }

  /**
   * Get all child process PIDs (Windows-specific)
   */
  private async getChildProcesses(parentPid: number): Promise<number[]> {
    if (process.platform !== 'win32') {
      return [];
    }

    // SECURITY: Validate PID is a positive integer to prevent command injection
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      logger.warn('SYSTEM', 'Invalid parent PID for child process enumeration', { parentPid });
      return [];
    }

    try {
      const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      return stdout
        .trim()
        .split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && Number.isInteger(n) && n > 0); // SECURITY: Validate each PID
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to enumerate child processes', {}, error as Error);
      return [];
    }
  }

  /**
   * Force kill a process by PID (Windows: uses taskkill /F /T)
   */
  private async forceKillProcess(pid: number): Promise<void> {
    // SECURITY: Validate PID is a positive integer to prevent command injection
    if (!Number.isInteger(pid) || pid <= 0) {
      logger.warn('SYSTEM', 'Invalid PID for force kill', { pid });
      return;
    }

    try {
      if (process.platform === 'win32') {
        // /T kills entire process tree, /F forces termination
        await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
        logger.info('SYSTEM', 'Killed process', { pid });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (error) {
      // Process may already be dead, which is fine
      logger.debug('SYSTEM', 'Process already dead or kill failed', { pid });
    }
  }

  /**
   * Wait for processes to fully exit
   */
  private async waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const stillAlive = pids.filter(pid => {
        try {
          process.kill(pid, 0); // Signal 0 checks if process exists
          return true;
        } catch {
          return false;
        }
      });

      if (stillAlive.length === 0) {
        logger.info('SYSTEM', 'All child processes exited');
        return;
      }

      logger.debug('SYSTEM', 'Waiting for processes to exit', { stillAlive });
      await new Promise(r => setTimeout(r, 100));
    }

    logger.warn('SYSTEM', 'Timeout waiting for child processes to exit');
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
