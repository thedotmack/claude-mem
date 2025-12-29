/**
 * Worker Service - Slim Orchestrator
 *
 * Refactored from 2000-line monolith to ~150-line orchestrator.
 * Routes organized by feature area in http/routes/*.ts
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
import { exec, execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

// PID file management for self-spawn pattern
const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');
const HOOK_RESPONSE = '{"continue": true, "suppressOutput": true}';

interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

// PID file utility functions
function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
}

function readPidFile(): PidInfo | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to read PID file', { path: PID_FILE, error: (error as Error).message });
    return null;
  }
}

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE, error: (error as Error).message });
  }
}

// Lockfile for CLI command mutual exclusion (prevents race conditions on Windows)
const LOCK_FILE = path.join(DATA_DIR, 'worker.lock');
const LOCK_STALE_MS = 120000; // Lock considered stale after 2 minutes

interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
}

/**
 * Clean up stale lock from crashed processes
 */
function cleanupStaleLock(): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const lockData = readFileSync(LOCK_FILE, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(lockData);
    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    if (lockAge > LOCK_STALE_MS) {
      logger.warn('SYSTEM', 'Removing stale lock', {
        lockAge: Math.round(lockAge / 1000) + 's',
        originalPid: lockInfo.pid,
        originalCommand: lockInfo.command
      });
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // If we can't read the lock, it's likely corrupted - remove it
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}

/**
 * Acquire exclusive lock for worker operations
 * Uses atomic file creation (O_EXCL) for cross-process safety
 */
function acquireLock(command: string): boolean {
  mkdirSync(DATA_DIR, { recursive: true });
  cleanupStaleLock();

  const lockInfo: LockInfo = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString()
  };

  let retries = 3;
  while (retries > 0) {
    try {
      // O_EXCL ensures atomic creation - fails if file exists
      const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, JSON.stringify(lockInfo, null, 2));
      fs.closeSync(fd);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      // Retry on ENOENT (can happen on Windows if file/dir state is in flux)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        retries--;
        if (retries === 0) {
          logger.warn('SYSTEM', 'Lock acquisition error (ENOENT)', { error: (error as Error).message });
          return false;
        }
        // Ensure directory exists and try again
        try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
        continue;
      }
      logger.warn('SYSTEM', 'Lock acquisition error', { error: (error as Error).message });
      return false;
    }
  }
  return false;
}

/**
 * Release lock file
 */
function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch (error) {
    logger.warn('SYSTEM', 'Lock release error', { error: (error as Error).message });
  }
}

/**
 * Wait for lock with timeout
 */
async function waitForLock(command: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (acquireLock(command)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Get platform-adjusted timeout (Windows socket cleanup is slower)
 */
function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch { return false; }
}

async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function httpShutdown(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { port, status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    // Connection refused is expected if worker already stopped
    const isConnectionRefused = (error as Error).message?.includes('ECONNREFUSED');
    if (!isConnectionRefused) {
      logger.warn('SYSTEM', 'Shutdown request failed', { port, error: (error as Error).message });
    }
    return false;
  }
}

async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Import composed service layer
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { GeminiAgent } from './worker/GeminiAgent.js';
import { OpenRouterAgent } from './worker/OpenRouterAgent.js';
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
  private isShuttingDown: boolean = false;

  // Service layer
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private geminiAgent: GeminiAgent;
  private openRouterAgent: OpenRouterAgent;
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

    // Initialize service layer
    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);
    this.geminiAgent = new GeminiAgent(this.dbManager, this.sessionManager);
    this.geminiAgent.setFallbackAgent(this.sdkAgent);  // Enable fallback to Claude on Gemini API failure
    this.openRouterAgent = new OpenRouterAgent(this.dbManager, this.sessionManager);
    this.openRouterAgent.setFallbackAgent(this.sdkAgent);  // Enable fallback to Claude on OpenRouter API failure
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
    this.sessionRoutes = new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.sessionEventBroadcaster, this);
    this.dataRoutes = new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime);
    // SearchRoutes needs SearchManager which requires initialized DB - will be created in initializeBackground()
    this.searchRoutes = null;
    this.settingsRoutes = new SettingsRoutes(this.settingsManager);

    this.setupMiddleware();
    this.setupRoutes();

    // Register signal handlers early to ensure cleanup even if start() hasn't completed
    // The shutdown() method is defensive and safe to call at any initialization stage
    this.registerSignalHandlers();
  }

  /**
   * Register signal handlers for graceful shutdown
   * Called in constructor to ensure cleanup even if start() hasn't completed
   */
  private registerSignalHandlers(): void {
    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
        return;
      }
      this.isShuttingDown = true;

      logger.info('SYSTEM', `Received ${signal}, shutting down...`);
      try {
        await this.shutdown();
        process.exit(0);
      } catch (error) {
        logger.error('SYSTEM', 'Error during shutdown', {}, error as Error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
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

      // Read version from marketplace package.json
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      res.status(200).json({ version: packageJson.version });
    });

    // Instructions endpoint - loads SKILL.md sections on-demand for progressive instruction loading
    this.app.get('/api/instructions', async (req, res) => {
      const topic = (req.query.topic as string) || 'all';
      const operation = req.query.operation as string | undefined;

      // Path resolution: __dirname is build output directory (plugin/scripts/)
      // SKILL.md is at plugin/skills/mem-search/SKILL.md
      // Operations are at plugin/skills/mem-search/operations/*.md

      try {
        let content: string;

        if (operation) {
          // Load specific operation file
          const operationPath = path.join(__dirname, '../skills/mem-search/operations', `${operation}.md`);
          content = await fs.promises.readFile(operationPath, 'utf-8');
        } else {
          // Load SKILL.md and extract section based on topic (backward compatibility)
          const skillPath = path.join(__dirname, '../skills/mem-search/SKILL.md');
          const fullContent = await fs.promises.readFile(skillPath, 'utf-8');
          content = this.extractInstructionSection(fullContent, topic);
        }

        // Return in MCP format
        res.json({
          content: [{
            type: 'text',
            text: content
          }]
        });
      } catch (error) {
        logger.error('WORKER', 'Failed to load instructions', { topic, operation }, error as Error);
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
        const timeoutMs = 300000; // 5 minute timeout for slow systems
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
        );
        
        await Promise.race([this.initializationComplete, timeoutPromise]);

        // If searchRoutes is still null after initialization, something went wrong
        if (!this.searchRoutes) {
          res.status(503).json({ error: 'Search routes not initialized' });
          return;
        }

        // Delegate to the SearchRoutes handler which is registered after this one
        // This avoids code duplication and "headers already sent" errors
        next();
      } catch (error) {
        logger.error('WORKER', 'Context inject handler failed', {}, error as Error);
        if (!res.headersSent) {
          res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
        }
      }
    });
  }


  /**
   * Clean up orphaned chroma-mcp processes from previous worker sessions
   * Prevents process accumulation and memory leaks
   */
  private async cleanupOrphanedProcesses(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const pids: number[] = [];

    if (isWindows) {
      // Windows: Use PowerShell Get-CimInstance to find chroma-mcp processes
      const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*python*' -and $_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: 60000 });

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
          execSync(`taskkill /PID ${pid} /T /F`, { timeout: 60000, stdio: 'ignore' });
        } catch {
          // Process may have already exited - continue cleanup
        }
      }
    } else {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited - that's fine
        }
      }
    }

    logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: pids.length });
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

      // Load mode configuration (must happen before database to set observation types)
      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const modeId = settings.CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      // Initialize database (once, stays open)
      await this.dbManager.initialize();

      // Recover stuck messages from previous crashes
      // Messages stuck in 'processing' state are reset to 'pending' for reprocessing
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
      if (resetCount > 0) {
        logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`, { thresholdMinutes: 5 });
      }

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

      // Add timeout guard to prevent hanging on MCP connection (5 minutes for slow systems)
      const MCP_INIT_TIMEOUT_MS = 300000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
      );

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      // Signal that initialization is complete
      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Background initialization complete');

      // Auto-recover orphaned queues on startup (process pending work from previous sessions)
      this.processPendingQueues(50).then(result => {
        if (result.sessionsStarted > 0) {
          logger.info('SYSTEM', `Auto-recovered ${result.sessionsStarted} sessions with pending work`, {
            totalPending: result.totalPendingSessions,
            started: result.sessionsStarted,
            sessionIds: result.startedSessionIds
          });
        }
      }).catch(error => {
        logger.warn('SYSTEM', 'Auto-recovery of pending queues failed', {}, error as Error);
      });
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      // Don't resolve - let the promise remain pending so readiness check continues to fail
      throw error;
    }
  }

  /**
   * Start a session processor
   * It will run continuously until the session is deleted/aborted
   */
  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string
  ): void {
    if (!session) return;

    const sid = session.sessionDbId;
    logger.info('SYSTEM', `Starting generator (${source})`, {
      sessionId: sid
    });

    session.generatorPromise = this.sdkAgent.startSession(session, this)
      .catch(error => {
        // Only log if not aborted
        if (session.abortController.signal.aborted) return;
        
        logger.error('SYSTEM', `Generator failed (${source})`, {
          sessionId: sid,
          error: error.message
        }, error);
      })
      .finally(() => {
        session.generatorPromise = null;
        this.broadcastProcessingStatus();
        
        // Crash recovery: if not aborted, check if we should restart
        if (!session.abortController.signal.aborted) {
           // We can check if there are pending messages to decide if restart is urgent
           // But generally, if it crashed, we might want to restart?
           // For now, let's just log. The user/system can trigger restart if needed.
           logger.warn('SYSTEM', `Session processor exited unexpectedly`, { sessionId: sid });
        }
      });
  }

  /**
   * Process pending session queues
   * Starts SDK agents for sessions that have pending messages but no active processor
   * @param sessionLimit Maximum number of sessions to start processing (default: 10)
   * @returns Info about what was started
   */
  async processPendingQueues(sessionLimit: number = 10): Promise<{
    totalPendingSessions: number;
    sessionsStarted: number;
    sessionsSkipped: number;
    startedSessionIds: number[];
  }> {
    const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
    const orphanedSessionIds = pendingStore.getSessionsWithPendingMessages();

    const result = {
      totalPendingSessions: orphanedSessionIds.length,
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[]
    };

    if (orphanedSessionIds.length === 0) {
      return result;
    }

    logger.info('SYSTEM', `Processing up to ${sessionLimit} of ${orphanedSessionIds.length} pending session queues`);

    // Process each session sequentially up to the limit
    for (const sessionDbId of orphanedSessionIds) {
      if (result.sessionsStarted >= sessionLimit) {
        break;
      }

      try {
        // Skip if session already has an active generator
        const existingSession = this.sessionManager.getSession(sessionDbId);
        if (existingSession?.generatorPromise) {
          result.sessionsSkipped++;
          continue;
        }

        // Initialize session and start SDK agent
        const session = this.sessionManager.initializeSession(sessionDbId);

        logger.info('SYSTEM', `Starting processor for session ${sessionDbId}`, {
          project: session.project,
          pendingCount: pendingStore.getPendingCount(sessionDbId)
        });

        // Start SDK agent (non-blocking)
        this.startSessionProcessor(session, 'startup-recovery');

        result.sessionsStarted++;
        result.startedSessionIds.push(sessionDbId);

        // Small delay between sessions to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.warn('SYSTEM', `Failed to process session ${sessionDbId}`, {}, error as Error);
        result.sessionsSkipped++;
      }
    }

    return result;
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

    // Clean up PID file on shutdown
    removePidFile();

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
      await this.mcpClient.close();
      logger.info('SYSTEM', 'MCP client closed');
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
      const { stdout } = await execAsync(cmd, { timeout: 60000 });
      return stdout
        .trim()
        .split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && Number.isInteger(n) && n > 0); // SECURITY: Validate each PID
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to enumerate child processes', { parentPid, error: (error as Error).message });
      return []; // Fail safely - continue shutdown without child process cleanup
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
        await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: 60000 });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      logger.info('SYSTEM', 'Killed process', { pid });
    } catch {
      // Process may have already exited - continue shutdown
      logger.debug('SYSTEM', 'Process already exited during force kill', { pid });
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
          process.kill(pid, 0);
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
// CLI Entry Point
// ============================================================================

async function main() {
  const command = process.argv[2];
  const port = getWorkerPort();

  switch (command) {
    case 'start': {
      // Acquire lock BEFORE checking port to prevent race condition
      // If we can't get lock, another session is spawning - wait for health instead
      if (!acquireLock('start')) {
        logger.info('SYSTEM', 'Another session is spawning worker, waiting for health');
        const healthy = await waitForHealth(port, getPlatformTimeout(30000));
        if (healthy) {
          logger.info('SYSTEM', 'Worker healthy, returning success');
          process.exit(0);
        }
        // Still not healthy after wait - try to acquire lock and spawn
        const gotLock = await waitForLock('start', 5000);
        if (!gotLock) {
          logger.error('SYSTEM', 'Failed to acquire lock after timeout');
          process.exit(1);
        }
      }

      try {
        // Re-check port AFTER acquiring lock
        if (await isPortInUse(port)) {
          releaseLock();
          logger.info('SYSTEM', 'Port already in use, worker already running');
          process.exit(0);
        }

        // Spawn self as daemon
        const child = spawn(process.execPath, [__filename, '--daemon'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) }
        });

        if (child.pid === undefined) {
          releaseLock();
          logger.error('SYSTEM', 'Failed to spawn worker daemon');
          process.exit(1);
        }

        child.unref();

        // Write PID file
        writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });

        // Wait for health with platform-adjusted timeout
        const healthy = await waitForHealth(port, getPlatformTimeout(30000));
        releaseLock();

        if (!healthy) {
          removePidFile();
          logger.error('SYSTEM', 'Worker failed to start');
          process.exit(1);
        }

        logger.info('SYSTEM', 'Worker started successfully');
        process.exit(0);
      } catch (error) {
        releaseLock();
        throw error;
      }
    }

    case 'stop': {
      // Acquire lock for stop operation
      if (!acquireLock('stop')) {
        // Wait briefly for concurrent operation to complete
        await new Promise(r => setTimeout(r, 2000));
      }

      try {
        await httpShutdown(port);
        const freed = await waitForPortFree(port, getPlatformTimeout(15000));
        
        if (!freed) {
          logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
          // Could force kill here if we knew the PID, but for now just warn
        }
        
        removePidFile();
        releaseLock();
        logger.info('SYSTEM', 'Worker stopped successfully');
        process.exit(0);
      } catch (error) {
        releaseLock();
        throw error;
      }
    }

    case 'restart': {
      // Acquire lock for restart operation
      if (!acquireLock('restart')) {
        // Another session is already restarting - wait for health
        logger.info('SYSTEM', 'Another session is restarting worker, waiting');
        const healthy = await waitForHealth(port, getPlatformTimeout(45000));
        if (healthy) {
          logger.info('SYSTEM', 'Worker healthy after restart');
          process.exit(0);
        }
        logger.error('SYSTEM', 'Worker failed to restart (concurrent operation)');
        process.exit(1);
      }

      try {
        await httpShutdown(port);
        const freed = await waitForPortFree(port, getPlatformTimeout(15000));
        
        if (!freed) {
          releaseLock();
          logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
          process.exit(1);
        }
        
        removePidFile();

        const child = spawn(process.execPath, [__filename, '--daemon'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) }
        });

        if (child.pid === undefined) {
          releaseLock();
          logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
          process.exit(1);
        }

        child.unref();
        writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });

        const healthy = await waitForHealth(port, getPlatformTimeout(30000));
        releaseLock();

        if (!healthy) {
          removePidFile();
          logger.error('SYSTEM', 'Worker failed to restart');
          process.exit(1);
        }
        logger.info('SYSTEM', 'Worker restarted successfully');
        process.exit(0);
      } catch (error) {
        releaseLock();
        throw error;
      }
    }

    case 'status': {
      const running = await isPortInUse(port);
      const pidInfo = readPidFile();
      if (running && pidInfo) {
        logger.info('SYSTEM', `Worker running (PID: ${pidInfo.pid}, Port: ${pidInfo.port})`);
      } else {
        logger.info('SYSTEM', 'Worker not running');
      }
      process.exit(0);
    }

    case '--daemon':
    default: {
      // Run server directly
      const worker = new WorkerService();

      worker.start().catch((error) => {
        logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
        removePidFile();
        process.exit(1);
      });
    }
  }
}

if (require.main === module || !module.parent) {
  main();
}
