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
import * as readline from 'readline';
import { promisify } from 'util';
import {
  readCursorRegistry as readCursorRegistryFromFile,
  writeCursorRegistry as writeCursorRegistryToFile,
  writeContextFile,
  type CursorProjectRegistry
} from '../utils/cursor-utils.js';

const execAsync = promisify(exec);

// Build-time injected version constant (set by esbuild define)
declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';

// PID file management for self-spawn pattern
const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');
const CURSOR_REGISTRY_FILE = path.join(DATA_DIR, 'cursor-projects.json');
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

// ============================================================================
// Cursor Project Registry
// Tracks which projects have Cursor hooks installed for auto-context updates
// Uses pure functions from cursor-utils.ts for testability
// ============================================================================

function readCursorRegistry(): CursorProjectRegistry {
  return readCursorRegistryFromFile(CURSOR_REGISTRY_FILE);
}

function writeCursorRegistry(registry: CursorProjectRegistry): void {
  writeCursorRegistryToFile(CURSOR_REGISTRY_FILE, registry);
}

function registerCursorProject(projectName: string, workspacePath: string): void {
  const registry = readCursorRegistry();
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString()
  };
  writeCursorRegistry(registry);
  logger.info('CURSOR', 'Registered project for auto-context updates', { projectName, workspacePath });
}

function unregisterCursorProject(projectName: string): void {
  const registry = readCursorRegistry();
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registry);
    logger.info('CURSOR', 'Unregistered project', { projectName });
  }
}

/**
 * Update Cursor context files for all registered projects matching this project name.
 * Called by SDK agents after saving a summary.
 */
export async function updateCursorContextForProject(projectName: string, port: number): Promise<void> {
  const registry = readCursorRegistry();
  const entry = registry[projectName];

  if (!entry) return; // Project doesn't have Cursor hooks installed

  try {
    // Fetch fresh context from worker
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
    );

    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;

    // Write to the project's Cursor rules file using shared utility
    writeContextFile(entry.workspacePath, context);
    logger.debug('CURSOR', 'Updated context file', { projectName, workspacePath: entry.workspacePath });
  } catch (error) {
    logger.warn('CURSOR', 'Failed to update context file', { projectName, error: (error as Error).message });
  }
}

// No lock file needed - health checks and port binding provide coordination

/**
 * Get platform-adjusted timeout (Windows socket cleanup is slower)
 */
function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch { return false; }
}

async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
      const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
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
    // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
      method: 'POST'
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

/**
 * Get the plugin version from the installed marketplace package.json
 */
function getInstalledPluginVersion(): string {
  const marketplaceRoot = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
  const packageJsonPath = path.join(marketplaceRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Get the running worker's version via API
 */
async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`);
    if (!response.ok) return null;
    const data = await response.json() as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

/**
 * Check if worker version matches plugin version
 * Returns true if versions match or if we can't determine (assume match)
 */
async function checkVersionMatch(port: number): Promise<{ matches: boolean; pluginVersion: string; workerVersion: string | null }> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  // If we can't get worker version, assume it matches (graceful degradation)
  if (!workerVersion) {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}

// Import composed service layer
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { GeminiAgent } from './worker/GeminiAgent.js';
import { OpenRouterAgent } from './worker/OpenRouterAgent.js';
import { OpenAICompatibleAgent } from './worker/OpenAICompatibleAgent.js';
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
  private openAICompatibleAgent: OpenAICompatibleAgent;
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
    this.openAICompatibleAgent = new OpenAICompatibleAgent(this.dbManager, this.sessionManager);
    this.openAICompatibleAgent.setFallbackAgent(this.sdkAgent);  // Enable fallback to Claude on OpenAI-compatible API failure
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
    this.sessionRoutes = new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.openAICompatibleAgent, this.sessionEventBroadcaster, this);
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

    // Version endpoint - returns the worker's built-in version (compiled at build time)
    // This is critical for detecting version mismatch when plugin is updated but worker is still running old code
    this.app.get('/api/version', (_req, res) => {
      res.status(200).json({ version: BUILT_IN_VERSION });
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

      // Give Windows time to close connections before closing server (prevents zombie ports)
      if (process.platform === 'win32') {
        await new Promise(r => setTimeout(r, 500));
      }

      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
      this.server = null;
      logger.info('SYSTEM', 'HTTP server closed');

      // Extra delay on Windows to ensure port is fully released
      if (process.platform === 'win32') {
        await new Promise(r => setTimeout(r, 500));
        logger.info('SYSTEM', 'Waited for Windows port cleanup');
      }
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
// Cursor Hooks Installation
// ============================================================================

/**
 * Interactive setup wizard for Cursor users
 * Guides through provider selection and API key configuration
 */
async function runInteractiveSetup(): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => rl.question(prompt, resolve));
  };

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           Claude-Mem Cursor Setup Wizard                         ║
║                                                                  ║
║  This wizard will guide you through setting up claude-mem        ║
║  for use with Cursor IDE.                                        ║
╚══════════════════════════════════════════════════════════════════╝
`);

  try {
    // Step 1: Check environment
    console.log('Step 1: Checking environment...\n');

    const hasClaudeCode = await detectClaudeCode();
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    let settings: Record<string, unknown> = {};

    // Load existing settings if present
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {
        // Start fresh if corrupt
      }
    }

    const currentProvider = settings['CLAUDE_MEM_PROVIDER'] as string || (hasClaudeCode ? 'claude-sdk' : 'none');

    if (hasClaudeCode) {
      console.log('✅ Claude Code detected\n');
    } else {
      console.log('ℹ️  Claude Code not detected\n');
    }

    console.log(`Current provider: ${currentProvider}\n`);

    // Step 2: Provider selection (always show)
    console.log('Step 2: Choose AI Provider\n');
    if (hasClaudeCode) {
      console.log('  [1] Claude SDK (Recommended - uses your Claude Code subscription)');
    } else {
      console.log('  [1] Claude SDK (requires Claude Code subscription)');
    }
    console.log('  [2] Gemini (1500 free requests/day)');
    console.log('  [3] OpenRouter (100+ models, some free)');
    console.log('  [4] Keep current settings\n');

    const providerChoice = await question('Enter choice [1-4]: ');

    if (providerChoice === '1') {
      settings['CLAUDE_MEM_PROVIDER'] = 'claude-sdk';
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('\n✅ Claude SDK configured!\n');
    } else if (providerChoice === '2') {
      console.log('\n📝 Configuring Gemini...\n');
      console.log('   Get your free API key at: https://aistudio.google.com/apikey\n');

      const apiKey = await question('Enter your Gemini API key: ');

      if (!apiKey.trim()) {
        console.log('\n⚠️  No API key provided. You can add it later in ~/.claude-mem/settings.json\n');
      } else {
        settings['CLAUDE_MEM_PROVIDER'] = 'gemini';
        settings['CLAUDE_MEM_GEMINI_API_KEY'] = apiKey.trim();

        mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('\n✅ Gemini configured successfully!\n');
      }
    } else if (providerChoice === '3') {
      console.log('\n📝 Configuring OpenRouter...\n');
      console.log('   Get your API key at: https://openrouter.ai/keys\n');

      const apiKey = await question('Enter your OpenRouter API key: ');

      if (!apiKey.trim()) {
        console.log('\n⚠️  No API key provided. You can add it later in ~/.claude-mem/settings.json\n');
      } else {
        settings['CLAUDE_MEM_PROVIDER'] = 'openrouter';
        settings['CLAUDE_MEM_OPENROUTER_API_KEY'] = apiKey.trim();

        mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('\n✅ OpenRouter configured successfully!\n');
      }
    } else {
      console.log('\n✅ Keeping current settings.\n');
    }

    // Step 3: Install location
    console.log('Step 3: Choose installation scope\n');
    console.log('  [1] Project (current directory only) - Recommended');
    console.log('  [2] User (all projects for current user)');
    console.log('  [3] Skip hook installation\n');

    const scopeChoice = await question('Enter choice [1-3]: ');

    let installTarget: string | null = null;
    if (scopeChoice === '1') {
      installTarget = 'project';
    } else if (scopeChoice === '2') {
      installTarget = 'user';
    } else {
      console.log('\n⚠️  Skipping hook installation.\n');
    }

    // Step 4: Install hooks (if target selected)
    if (installTarget) {
      console.log(`Step 4: Installing Cursor hooks (${installTarget})...\n`);

      const cursorHooksDir = findCursorHooksDir();
      if (!cursorHooksDir) {
        console.error('❌ Could not find cursor-hooks directory');
        console.error('   Make sure you ran npm run build first.');
        rl.close();
        return 1;
      }

      const installResult = await installCursorHooks(cursorHooksDir, installTarget);

      if (installResult !== 0) {
        rl.close();
        return installResult;
      }

      // Step 5: Configure MCP server for memory search
      console.log('\nStep 5: Configuring MCP server for memory search...\n');

      const mcpResult = configureCursorMcp(installTarget);
      if (mcpResult !== 0) {
        console.warn('⚠️  MCP configuration failed, but hooks are installed.');
        console.warn('   You can manually configure MCP later.\n');
      } else {
        console.log('');
      }
    }

    // Step 6: Start worker
    console.log('\nStep 6: Starting claude-mem worker...\n');

    const port = getWorkerPort();
    const alreadyRunning = await waitForHealth(port, 1000);

    if (alreadyRunning) {
      console.log('✅ Worker is already running!\n');
    } else {
      console.log('   Starting worker in background...');

      // Spawn worker daemon
      const child = spawn(process.execPath, [__filename, '--daemon'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) }
      });

      if (child.pid === undefined) {
        console.error('❌ Failed to start worker');
        rl.close();
        return 1;
      }

      child.unref();
      writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });

      // Wait for health
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));

      if (!healthy) {
        removePidFile();
        console.error('❌ Worker failed to start');
        rl.close();
        return 1;
      }

      console.log('✅ Worker started successfully!\n');
    }

    // Final summary
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Setup Complete! 🎉                            ║
╚══════════════════════════════════════════════════════════════════╝

What's installed:
  ✓ Cursor hooks - Automatically capture sessions
  ✓ Context injection - Past work injected into new chats
  ✓ MCP search server - Ask "what did I work on last week?"

Next steps:
  1. Restart Cursor to load the hooks and MCP server
  2. Start chatting - your sessions will be remembered!
  3. Use natural language to search: "find where I fixed the auth bug"

Useful commands:
  npm run cursor:status     Check installation status
  npm run worker:status     Check worker status
  npm run worker:logs       View worker logs

Memory viewer:
  http://localhost:${port}

Documentation:
  https://docs.claude-mem.ai/cursor
`);

    rl.close();
    return 0;
  } catch (error) {
    rl.close();
    console.error(`\n❌ Setup failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Detect if Claude Code is available
 * Checks for the Claude Code CLI and plugin directory
 */
async function detectClaudeCode(): Promise<boolean> {
  try {
    // Check for Claude Code CLI
    const { stdout } = await execAsync('which claude || where claude', { timeout: 5000 });
    if (stdout.trim()) {
      return true;
    }
  } catch {
    // CLI not found
  }

  // Check for Claude Code plugin directory
  const pluginDir = path.join(homedir(), '.claude', 'plugins');
  if (existsSync(pluginDir)) {
    return true;
  }

  return false;
}

/**
 * Find cursor-hooks directory
 * Searches in order: marketplace install, source repo
 * Checks for both bash (common.sh) and PowerShell (common.ps1) scripts
 */
function findCursorHooksDir(): string | null {
  const possiblePaths = [
    // Marketplace install location
    path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'cursor-hooks'),
    // Development/source location (relative to built worker-service.cjs in plugin/scripts/)
    path.join(path.dirname(__filename), '..', '..', 'cursor-hooks'),
    // Alternative dev location
    path.join(process.cwd(), 'cursor-hooks'),
  ];

  for (const p of possiblePaths) {
    // Check for either bash or PowerShell common script
    if (existsSync(path.join(p, 'common.sh')) || existsSync(path.join(p, 'common.ps1'))) {
      return p;
    }
  }
  return null;
}

/**
 * Find MCP server script path
 * Searches in order: marketplace install, source repo
 */
function findMcpServerPath(): string | null {
  const possiblePaths = [
    // Marketplace install location
    path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts', 'mcp-server.cjs'),
    // Development/source location (relative to built worker-service.cjs in plugin/scripts/)
    path.join(path.dirname(__filename), 'mcp-server.cjs'),
    // Alternative dev location
    path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

interface CursorMcpConfig {
  mcpServers: {
    [name: string]: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
}

/**
 * Configure MCP server in Cursor's mcp.json
 * @param target 'project' or 'user'
 * @returns 0 on success, 1 on failure
 */
function configureCursorMcp(target: string): number {
  const mcpServerPath = findMcpServerPath();

  if (!mcpServerPath) {
    console.error('❌ Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  let mcpJsonDir: string;
  let mcpJsonPath: string;

  switch (target) {
    case 'project':
      mcpJsonDir = path.join(process.cwd(), '.cursor');
      mcpJsonPath = path.join(mcpJsonDir, 'mcp.json');
      break;
    case 'user':
      mcpJsonDir = path.join(homedir(), '.cursor');
      mcpJsonPath = path.join(mcpJsonDir, 'mcp.json');
      break;
    default:
      console.error(`❌ Invalid target: ${target}. Use: project or user`);
      return 1;
  }

  try {
    // Create directory if needed
    mkdirSync(mcpJsonDir, { recursive: true });

    // Load existing config or create new
    let config: CursorMcpConfig = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      try {
        config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
      } catch {
        // Start fresh if corrupt
        config = { mcpServers: {} };
      }
    }

    // Add claude-mem MCP server
    config.mcpServers['claude-mem'] = {
      command: 'node',
      args: [mcpServerPath]
    };

    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
    console.log(`  ✓ Configured MCP server in ${target === 'user' ? '~/.cursor' : '.cursor'}/mcp.json`);
    console.log(`    Server path: ${mcpServerPath}`);

    return 0;
  } catch (error) {
    console.error(`❌ Failed to configure MCP: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Handle cursor subcommand for hooks installation
 */
async function handleCursorCommand(subcommand: string, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const target = args[0] || 'project';
      const cursorHooksDir = findCursorHooksDir();
      
      if (!cursorHooksDir) {
        console.error('❌ Could not find cursor-hooks directory');
        console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/cursor-hooks/');
        return 1;
      }
      
      return installCursorHooks(cursorHooksDir, target);
    }
    
    case 'uninstall': {
      const target = args[0] || 'project';
      return uninstallCursorHooks(target);
    }
    
    case 'status': {
      return checkCursorHooksStatus();
    }

    case 'setup': {
      // Interactive guided setup for Cursor users
      return await runInteractiveSetup();
    }

    default: {
      console.log(`
Claude-Mem Cursor Integration

Usage: claude-mem cursor <command> [options]

Commands:
  setup               Interactive guided setup (recommended for first-time users)

  install [target]    Install Cursor hooks
                      target: project (default), user, or enterprise

  uninstall [target]  Remove Cursor hooks
                      target: project (default), user, or enterprise

  status              Check installation status

Examples:
  npm run cursor:setup                   # Interactive wizard (recommended)
  npm run cursor:install                 # Install for current project
  claude-mem cursor install user         # Install globally for user
  claude-mem cursor uninstall            # Remove from current project
  claude-mem cursor status               # Check if hooks are installed

For more info: https://docs.claude-mem.ai/cursor
      `);
      return 0;
    }
  }
}

/**
 * Detect platform for script selection
 */
function detectPlatform(): 'windows' | 'unix' {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

/**
 * Get script extension based on platform
 */
function getScriptExtension(): string {
  return detectPlatform() === 'windows' ? '.ps1' : '.sh';
}

/**
 * Install Cursor hooks
 */
async function installCursorHooks(sourceDir: string, target: string): Promise<number> {
  const platform = detectPlatform();
  const scriptExt = getScriptExtension();

  console.log(`\n📦 Installing Claude-Mem Cursor hooks (${target} level, ${platform})...\n`);

  let targetDir: string;
  let hooksDir: string;
  let workspaceRoot: string = process.cwd();

  switch (target) {
    case 'project':
      targetDir = path.join(process.cwd(), '.cursor');
      hooksDir = path.join(targetDir, 'hooks');
      break;
    case 'user':
      targetDir = path.join(homedir(), '.cursor');
      hooksDir = path.join(targetDir, 'hooks');
      break;
    case 'enterprise':
      if (process.platform === 'darwin') {
        targetDir = '/Library/Application Support/Cursor';
        hooksDir = path.join(targetDir, 'hooks');
      } else if (process.platform === 'linux') {
        targetDir = '/etc/cursor';
        hooksDir = path.join(targetDir, 'hooks');
      } else if (process.platform === 'win32') {
        targetDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Cursor');
        hooksDir = path.join(targetDir, 'hooks');
      } else {
        console.error('❌ Enterprise installation not supported on this platform');
        return 1;
      }
      break;
    default:
      console.error(`❌ Invalid target: ${target}. Use: project, user, or enterprise`);
      return 1;
  }

  try {
    // Create directories
    mkdirSync(hooksDir, { recursive: true });

    // Determine which scripts to copy based on platform
    const commonScript = platform === 'windows' ? 'common.ps1' : 'common.sh';
    const hookScripts = [
      `session-init${scriptExt}`,
      `context-inject${scriptExt}`,
      `save-observation${scriptExt}`,
      `save-file-edit${scriptExt}`,
      `session-summary${scriptExt}`
    ];

    const scripts = [commonScript, ...hookScripts];

    for (const script of scripts) {
      const srcPath = path.join(sourceDir, script);
      const dstPath = path.join(hooksDir, script);

      if (existsSync(srcPath)) {
        const content = readFileSync(srcPath, 'utf-8');
        // Unix scripts need execute permission; Windows PowerShell doesn't need it
        const mode = platform === 'windows' ? undefined : 0o755;
        writeFileSync(dstPath, content, mode ? { mode } : undefined);
        console.log(`  ✓ Copied ${script}`);
      } else {
        console.warn(`  ⚠ ${script} not found in source`);
      }
    }

    // Generate hooks.json with correct paths and platform-appropriate commands
    const hooksJsonPath = path.join(targetDir, 'hooks.json');
    const hookPrefix = target === 'project' ? './.cursor/hooks/' : `${hooksDir}/`;

    // For PowerShell, we need to invoke via powershell.exe
    const makeHookCommand = (scriptName: string) => {
      const scriptPath = `${hookPrefix}${scriptName}${scriptExt}`;
      if (platform === 'windows') {
        // PowerShell execution: use -ExecutionPolicy Bypass to ensure scripts run
        return `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`;
      }
      return scriptPath;
    };

    const hooksJson = {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          { command: makeHookCommand('session-init') },
          { command: makeHookCommand('context-inject') }
        ],
        afterMCPExecution: [
          { command: makeHookCommand('save-observation') }
        ],
        afterShellExecution: [
          { command: makeHookCommand('save-observation') }
        ],
        afterFileEdit: [
          { command: makeHookCommand('save-file-edit') }
        ],
        stop: [
          { command: makeHookCommand('session-summary') }
        ]
      }
    };

    writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
    console.log(`  ✓ Created hooks.json (${platform} mode)`);
    
    // For project-level: create initial context file
    if (target === 'project') {
      const rulesDir = path.join(targetDir, 'rules');
      mkdirSync(rulesDir, { recursive: true });
      
      // Try to generate initial context from existing memory
      const port = getWorkerPort();
      const projectName = path.basename(workspaceRoot);
      let contextGenerated = false;
      
      console.log(`  ⏳ Generating initial context...`);
      
      try {
        // Check if worker is running
        const healthResponse = await fetch(`http://127.0.0.1:${port}/api/readiness`);
        if (healthResponse.ok) {
          // Fetch context
          const contextResponse = await fetch(
            `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
          );
          if (contextResponse.ok) {
            const context = await contextResponse.text();
            if (context && context.trim()) {
              const rulesFile = path.join(rulesDir, 'claude-mem-context.mdc');
              const contextContent = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

${context}

---
*This context is updated after each session. Use claude-mem's MCP search tools for more detailed queries.*
`;
              writeFileSync(rulesFile, contextContent);
              contextGenerated = true;
              console.log(`  ✓ Generated initial context from existing memory`);
            }
          }
        }
      } catch {
        // Worker not running - that's ok, context will be generated after first session
      }
      
      if (!contextGenerated) {
        // Create placeholder context file
        const rulesFile = path.join(rulesDir, 'claude-mem-context.mdc');
        const placeholderContent = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;
        writeFileSync(rulesFile, placeholderContent);
        console.log(`  ✓ Created placeholder context file (will populate after first session)`);
      }
      
      // Register project for automatic context updates after summaries
      registerCursorProject(projectName, workspaceRoot);
      console.log(`  ✓ Registered for auto-context updates`);
    }
    
    console.log(`
✅ Installation complete!

Hooks installed to: ${targetDir}/hooks.json
Scripts installed to: ${hooksDir}

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Cursor to load the hooks
  3. Check Cursor Settings → Hooks tab to verify

Context Injection:
  Context from past sessions is stored in .cursor/rules/claude-mem-context.mdc
  and automatically included in every chat. It updates after each session ends.
`);
    
    return 0;
  } catch (error) {
    console.error(`\n❌ Installation failed: ${(error as Error).message}`);
    if (target === 'enterprise') {
      console.error('   Tip: Enterprise installation may require sudo/admin privileges');
    }
    return 1;
  }
}

/**
 * Uninstall Cursor hooks
 */
function uninstallCursorHooks(target: string): number {
  console.log(`\n🗑️  Uninstalling Claude-Mem Cursor hooks (${target} level)...\n`);
  
  let targetDir: string;
  
  switch (target) {
    case 'project':
      targetDir = path.join(process.cwd(), '.cursor');
      break;
    case 'user':
      targetDir = path.join(homedir(), '.cursor');
      break;
    case 'enterprise':
      if (process.platform === 'darwin') {
        targetDir = '/Library/Application Support/Cursor';
      } else if (process.platform === 'linux') {
        targetDir = '/etc/cursor';
      } else {
        console.error('❌ Enterprise not supported on Windows');
        return 1;
      }
      break;
    default:
      console.error(`❌ Invalid target: ${target}`);
      return 1;
  }
  
  try {
    const hooksDir = path.join(targetDir, 'hooks');
    const hooksJsonPath = path.join(targetDir, 'hooks.json');

    // Remove hook scripts for both platforms (in case user switches platforms)
    const bashScripts = ['common.sh', 'session-init.sh', 'context-inject.sh',
                        'save-observation.sh', 'save-file-edit.sh', 'session-summary.sh'];
    const psScripts = ['common.ps1', 'session-init.ps1', 'context-inject.ps1',
                       'save-observation.ps1', 'save-file-edit.ps1', 'session-summary.ps1'];

    const allScripts = [...bashScripts, ...psScripts];

    for (const script of allScripts) {
      const scriptPath = path.join(hooksDir, script);
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        console.log(`  ✓ Removed ${script}`);
      }
    }
    
    // Remove hooks.json
    if (existsSync(hooksJsonPath)) {
      unlinkSync(hooksJsonPath);
      console.log(`  ✓ Removed hooks.json`);
    }
    
    // Remove context file and unregister if project-level
    if (target === 'project') {
      const contextFile = path.join(targetDir, 'rules', 'claude-mem-context.mdc');
      if (existsSync(contextFile)) {
        unlinkSync(contextFile);
        console.log(`  ✓ Removed context file`);
      }
      
      // Unregister from auto-context updates
      const projectName = path.basename(process.cwd());
      unregisterCursorProject(projectName);
      console.log(`  ✓ Unregistered from auto-context updates`);
    }
    
    console.log(`\n✅ Uninstallation complete!\n`);
    console.log('Restart Cursor to apply changes.');
    
    return 0;
  } catch (error) {
    console.error(`\n❌ Uninstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Check Cursor hooks installation status
 */
function checkCursorHooksStatus(): number {
  console.log('\n🔍 Claude-Mem Cursor Hooks Status\n');
  
  const locations = [
    { name: 'Project', dir: path.join(process.cwd(), '.cursor') },
    { name: 'User', dir: path.join(homedir(), '.cursor') },
  ];
  
  if (process.platform === 'darwin') {
    locations.push({ name: 'Enterprise', dir: '/Library/Application Support/Cursor' });
  } else if (process.platform === 'linux') {
    locations.push({ name: 'Enterprise', dir: '/etc/cursor' });
  }
  
  let anyInstalled = false;
  
  for (const loc of locations) {
    const hooksJson = path.join(loc.dir, 'hooks.json');
    const hooksDir = path.join(loc.dir, 'hooks');

    if (existsSync(hooksJson)) {
      anyInstalled = true;
      console.log(`✅ ${loc.name}: Installed`);
      console.log(`   Config: ${hooksJson}`);

      // Detect which platform's scripts are installed
      const bashScripts = ['session-init.sh', 'context-inject.sh', 'save-observation.sh'];
      const psScripts = ['session-init.ps1', 'context-inject.ps1', 'save-observation.ps1'];

      const hasBash = bashScripts.some(s => existsSync(path.join(hooksDir, s)));
      const hasPs = psScripts.some(s => existsSync(path.join(hooksDir, s)));

      if (hasBash && hasPs) {
        console.log(`   Platform: Both (bash + PowerShell)`);
      } else if (hasBash) {
        console.log(`   Platform: Unix (bash)`);
      } else if (hasPs) {
        console.log(`   Platform: Windows (PowerShell)`);
      } else {
        console.log(`   ⚠ No hook scripts found`);
      }

      // Check for appropriate scripts based on current platform
      const platform = detectPlatform();
      const scripts = platform === 'windows' ? psScripts : bashScripts;
      const missing = scripts.filter(s => !existsSync(path.join(hooksDir, s)));

      if (missing.length > 0) {
        console.log(`   ⚠ Missing ${platform} scripts: ${missing.join(', ')}`);
      } else {
        console.log(`   Scripts: All present for ${platform}`);
      }

      // Check for context file (project only)
      if (loc.name === 'Project') {
        const contextFile = path.join(loc.dir, 'rules', 'claude-mem-context.mdc');
        if (existsSync(contextFile)) {
          console.log(`   Context: Active`);
        } else {
          console.log(`   Context: Not yet generated (will be created on first prompt)`);
        }
      }
    } else {
      console.log(`❌ ${loc.name}: Not installed`);
    }
    console.log('');
  }
  
  if (!anyInstalled) {
    console.log('No hooks installed. Run: claude-mem cursor install\n');
  }
  
  return 0;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const command = process.argv[2];
  const port = getWorkerPort();

  switch (command) {
    case 'start': {
      // Health-check-first approach: simple, fast, reliable
      // Check if worker is already healthy
      if (await waitForHealth(port, 1000)) {
        // Worker is healthy - check for version mismatch (issue #484)
        const versionCheck = await checkVersionMatch(port);
        if (!versionCheck.matches) {
          logger.info('SYSTEM', 'Worker version mismatch detected - auto-restarting', {
            pluginVersion: versionCheck.pluginVersion,
            workerVersion: versionCheck.workerVersion
          });

          // Shutdown the old worker
          await httpShutdown(port);
          const freed = await waitForPortFree(port, getPlatformTimeout(15000));

          if (!freed) {
            logger.error('SYSTEM', 'Port did not free up after shutdown for version mismatch restart', { port });
            process.exit(1);
          }

          removePidFile();
          // Fall through to spawn new daemon below
        } else {
          logger.info('SYSTEM', 'Worker already running and healthy');
          process.exit(0);
        }
      }

      // Worker not healthy - check if port is in use
      const portInUse = await isPortInUse(port);

      if (portInUse) {
        // Port in use but not healthy - wait a bit longer in case it's starting up
        logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
        const healthy = await waitForHealth(port, getPlatformTimeout(15000));
        if (healthy) {
          logger.info('SYSTEM', 'Worker is now healthy');
          process.exit(0);
        }
        logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
        process.exit(1);
      }

      // Port not in use - spawn daemon
      logger.info('SYSTEM', 'Starting worker daemon');
      const child = spawn(process.execPath, [__filename, '--daemon'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) }
      });

      if (child.pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        process.exit(1);
      }

      child.unref();

      // Write PID file
      writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });

      // Wait for health with platform-adjusted timeout
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));

      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
        process.exit(1);
      }

      logger.info('SYSTEM', 'Worker started successfully');
      process.exit(0);
    }

    case 'stop': {
      // Simple stop: send shutdown request, wait for port to free
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));

      if (!freed) {
        logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
        // Could force kill here if we knew the PID, but for now just warn
      }

      removePidFile();
      logger.info('SYSTEM', 'Worker stopped successfully');
      process.exit(0);
    }

    case 'restart': {
      // Simple restart: stop, then start
      logger.info('SYSTEM', 'Restarting worker');

      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));

      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
        process.exit(1);
      }

      removePidFile();

      // Spawn new daemon
      const child = spawn(process.execPath, [__filename, '--daemon'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) }
      });

      if (child.pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
        process.exit(1);
      }

      child.unref();
      writePidFile({ pid: child.pid, port, startedAt: new Date().toISOString() });

      // Wait for health
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));

      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to restart');
        process.exit(1);
      }

      logger.info('SYSTEM', 'Worker restarted successfully');
      process.exit(0);
    }

    case 'status': {
      const running = await isPortInUse(port);
      const pidInfo = readPidFile();
      if (running && pidInfo) {
        console.log('Worker is running');
        console.log(`  PID: ${pidInfo.pid}`);
        console.log(`  Port: ${pidInfo.port}`);
        console.log(`  Started: ${pidInfo.startedAt}`);
      } else {
        console.log('Worker is not running');
      }
      process.exit(0);
    }

    case 'cursor': {
      // Cursor hooks installation subcommand
      const subcommand = process.argv[3];
      const cursorResult = await handleCursorCommand(subcommand, process.argv.slice(4));
      process.exit(cursorResult);
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
