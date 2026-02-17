/**
 * Worker Service - Slim Orchestrator
 *
 * Refactored from 2000-line monolith to ~300-line orchestrator.
 * Delegates to specialized modules:
 * - src/services/server/ - HTTP server, middleware, error handling
 * - src/services/infrastructure/ - Process management, health monitoring, shutdown
 * - src/services/integrations/ - IDE integrations (Cursor)
 * - src/services/worker/ - Business logic, routes, agents
 */

import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// Infrastructure imports
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  cleanupOrphanedProcesses,
  spawnDaemon,
  createSignalHandler,
  getWorkerNodeBinary,
  verifyNativeModules
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  httpShutdown,
  checkVersionMatch
} from './infrastructure/HealthMonitor.js';
import { performGracefulShutdown } from './infrastructure/GracefulShutdown.js';

// Server imports
import { Server } from './server/Server.js';

// Integration imports
import {
  handleCursorCommand
} from './integrations/CursorHooksInstaller.js';

// Service layer imports
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { GeminiAgent } from './worker/GeminiAgent.js';
import { OpenAICompatAgent, isOpenAICompatSelected, isOpenAICompatAvailable } from './worker/OpenAICompatAgent.js';
import { isGeminiSelected, isGeminiAvailable } from './worker/GeminiAgent.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';
import { SearchManager } from './worker/SearchManager.js';
import { FormattingService } from './worker/FormattingService.js';
import { TimelineService } from './worker/TimelineService.js';
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';

// HTTP route handlers
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';

// Process management for zombie cleanup (Issue #737)
import { startOrphanReaper } from './worker/ProcessRegistry.js';

/**
 * Build JSON status output for hook framework communication.
 * This is a pure function extracted for testability.
 *
 * @param status - 'ready' for successful startup, 'error' for failures
 * @param message - Optional error message (only included when provided)
 * @returns JSON object with continue, suppressOutput, status, and optionally message
 */
export interface StatusOutput {
  continue: true;
  suppressOutput: true;
  status: 'ready' | 'error';
  message?: string;
}

export function buildStatusOutput(status: 'ready' | 'error', message?: string): StatusOutput {
  return {
    continue: true,
    suppressOutput: true,
    status,
    ...(message && { message })
  };
}

export class WorkerService {
  private server: Server;
  private startTime: number = Date.now();
  private mcpClient: Client;

  // Initialization flags
  private mcpReady: boolean = false;
  private initializationCompleteFlag: boolean = false;
  private isShuttingDown: boolean = false;

  // Service layer
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private geminiAgent: GeminiAgent;
  private openaiCompatAgent: OpenAICompatAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
  private sessionEventBroadcaster: SessionEventBroadcaster;

  // Route handlers
  private searchRoutes: SearchRoutes | null = null;

  // Initialization tracking
  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

  // Orphan reaper cleanup function (Issue #737)
  private stopOrphanReaper: (() => void) | null = null;

  constructor() {
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
    this.openaiCompatAgent = new OpenAICompatAgent(this.dbManager, this.sessionManager);

    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);

    // Set callback for when sessions are deleted
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // Initialize MCP client
    // Empty capabilities object: this client only calls tools, doesn't expose any
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: packageVersion
    }, { capabilities: {} });

    // Initialize HTTP server with core routes
    this.server = new Server({
      getInitializationComplete: () => this.initializationCompleteFlag,
      getMcpReady: () => this.mcpReady,
      onShutdown: () => this.shutdown(),
      onRestart: () => this.shutdown()
    });

    // Register route handlers
    this.registerRoutes();

    // Register signal handlers early to ensure cleanup even if start() hasn't completed
    this.registerSignalHandlers();
  }

  /**
   * Register signal handlers for graceful shutdown
   */
  private registerSignalHandlers(): void {
    const shutdownRef = { value: this.isShuttingDown };
    const handler = createSignalHandler(() => this.shutdown(), shutdownRef);

    process.on('SIGTERM', () => {
      this.isShuttingDown = shutdownRef.value;
      void handler('SIGTERM');
    });
    process.on('SIGINT', () => {
      this.isShuttingDown = shutdownRef.value;
      void handler('SIGINT');
    });
  }

  /**
   * Register all route handlers with the server
   */
  private registerRoutes(): void {
    // Gate session routes on initialization (DB must be ready before accepting requests)
    // This prevents "Database not initialized" 500 errors during startup
    const gatedPrefixes = ['/api/sessions/', '/sessions/'];
    this.server.app.use((req, res, next) => {
      if (!gatedPrefixes.some(p => req.path.startsWith(p))) { next(); return; }
      if (this.initializationCompleteFlag) { next(); return; }

      const timeout = setTimeout(() => {
        res.status(503).json({ error: 'Worker still initializing' });
      }, 30000);

      this.initializationComplete.then(() => {
        clearTimeout(timeout);
        next();
      }).catch(() => {
        clearTimeout(timeout);
        res.status(503).json({ error: 'Initialization failed' });
      });
    });

    // Standard routes
    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));
    this.server.registerRoutes(new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openaiCompatAgent, this.sessionEventBroadcaster, this));
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));
    this.server.registerRoutes(new LogsRoutes());

    // Early handler for /api/context/inject to avoid 404 during startup
    this.server.app.get('/api/context/inject', (req, res, next) => {
      const timeoutMs = 300000; // 5 minute timeout for slow systems
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => { reject(new Error('Initialization timeout')); }, timeoutMs)
      );

      Promise.race([this.initializationComplete, timeoutPromise]).then(() => {
        if (!this.searchRoutes) {
          res.status(503).json({ error: 'Search routes not initialized' });
          return;
        }

        next(); // Delegate to SearchRoutes handler
      }).catch((error: unknown) => {
        res.status(503).json({ error: error instanceof Error ? error.message : 'Initialization failed' });
      });
    });
  }

  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    const port = getWorkerPort();
    const host = getWorkerHost();

    // Start HTTP server FIRST - make port available immediately
    await this.server.listen(port, host);

    // Worker writes its own PID - reliable on all platforms
    // This happens after listen() succeeds, ensuring the worker is actually ready
    // On Windows, the spawner's PID is cmd.exe (useless), so worker must write its own
    writePidFile({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      nodeVersion: process.version
    });

    logger.info('SYSTEM', 'Worker started', { host, port, pid: process.pid });

    // Do slow initialization in background (non-blocking)
    this.initializeBackground().catch((error: unknown) => {
      logger.error('SYSTEM', 'Background initialization failed', {}, error instanceof Error ? error : new Error(String(error)));
    });
  }

  /**
   * Background initialization - runs after HTTP server is listening
   */
  private async initializeBackground(): Promise<void> {
    try {
      await cleanupOrphanedProcesses();

      // Load mode configuration
      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const modeId = settings.MAGIC_CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      this.dbManager.initialize();

      // Recover stuck messages from previous crashes
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
      const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
      if (resetCount > 0) {
        logger.info('SYSTEM', `Recovered ${String(resetCount)} stuck messages from previous session`, { thresholdMinutes: 5 });
      }

      // Initialize search services
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
      this.server.registerRoutes(this.searchRoutes);
      logger.info('WORKER', 'SearchManager initialized and search routes registered');

      // DB + search ready — ungate session/observation routes now.
      // MCP (Chroma) connection can take 30s+ on first run; hooks only need SQLite.
      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Core initialization complete (DB + search ready, accepting requests)');

      // Connect to MCP server (non-blocking for route gate)
      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env: process.env as Record<string, string>
      });

      const MCP_INIT_TIMEOUT_MS = 300000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => { reject(new Error('MCP connection timeout after 5 minutes')); }, MCP_INIT_TIMEOUT_MS)
      );

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      // Start orphan reaper to clean up zombie processes (Issue #737)
      this.stopOrphanReaper = startOrphanReaper(() => {
        const activeIds = new Set<number>();
        for (const [id] of this.sessionManager['sessions']) {
          activeIds.add(id);
        }
        return activeIds;
      });
      logger.info('SYSTEM', 'Started orphan reaper (runs every 5 minutes)');

      // Auto-recover orphaned queues (fire-and-forget with error logging)
      this.processPendingQueues(50).then(result => {
        if (result.sessionsStarted > 0) {
          logger.info('SYSTEM', `Auto-recovered ${String(result.sessionsStarted)} sessions with pending work`, {
            totalPending: result.totalPendingSessions,
            started: result.sessionsStarted,
            sessionIds: result.startedSessionIds
          });
        }
      }).catch((error: unknown) => {
        logger.error('SYSTEM', 'Auto-recovery of pending queues failed', {}, error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      throw error;
    }
  }

  /**
   * Get the appropriate agent based on provider settings.
   * Mirrors SessionRoutes.getActiveAgent() to ensure recovery uses the same provider.
   */
  private getActiveAgent(): SDKAgent | GeminiAgent | OpenAICompatAgent {
    if (isOpenAICompatSelected() && isOpenAICompatAvailable()) {
      return this.openaiCompatAgent;
    }
    if (isGeminiSelected() && isGeminiAvailable()) {
      return this.geminiAgent;
    }
    return this.sdkAgent;
  }

  /**
   * Start a session processor
   */
  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string
  ): void {
    if (!session) return;

    const sid = session.sessionDbId;
    const agent = this.getActiveAgent();
    const providerName = agent instanceof OpenAICompatAgent ? 'OpenAI-Compat'
      : agent instanceof GeminiAgent ? 'Gemini' : 'Claude SDK';
    logger.info('SYSTEM', `Starting generator (${source}) using ${providerName}`, { sessionId: sid });

    session.generatorPromise = agent.startSession(session, this)
      .catch((error: unknown) => {
        logger.error('SDK', 'Session generator failed', {
          sessionId: session.sessionDbId,
          project: session.project,
          provider: providerName
        }, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        session.generatorPromise = null;
        this.broadcastProcessingStatus();
      });
  }

  /**
   * Process pending session queues
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

    if (orphanedSessionIds.length === 0) return result;

    logger.info('SYSTEM', `Processing up to ${String(sessionLimit)} of ${String(orphanedSessionIds.length)} pending session queues`);

    for (const sessionDbId of orphanedSessionIds) {
      if (result.sessionsStarted >= sessionLimit) break;

      try {
        const existingSession = this.sessionManager.getSession(sessionDbId);
        if (existingSession?.generatorPromise) {
          result.sessionsSkipped++;
          continue;
        }

        const session = this.sessionManager.initializeSession(sessionDbId);
        logger.info('SYSTEM', `Starting processor for session ${String(sessionDbId)}`, {
          project: session.project,
          pendingCount: pendingStore.getPendingCount(sessionDbId)
        });

        this.startSessionProcessor(session, 'startup-recovery');
        result.sessionsStarted++;
        result.startedSessionIds.push(sessionDbId);

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error('SYSTEM', `Failed to process session ${String(sessionDbId)}`, {}, error as Error);
        result.sessionsSkipped++;
      }
    }

    return result;
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
    // Stop orphan reaper before shutdown (Issue #737)
    if (this.stopOrphanReaper) {
      this.stopOrphanReaper();
      this.stopOrphanReaper = null;
    }

    await performGracefulShutdown({
      server: this.server.getHttpServer(),
      sessionManager: this.sessionManager,
      mcpClient: this.mcpClient,
      dbManager: this.dbManager
    });
  }

  /**
   * Broadcast processing status change to SSE clients
   */
  broadcastProcessingStatus(): void {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork();
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
// Reusable Worker Startup Logic
// ============================================================================

/**
 * Ensures the worker is started and healthy.
 * This function can be called by both 'start' and 'hook' commands.
 *
 * @param port - The port the worker should run on
 * @returns true if worker is healthy (existing or newly started), false on failure
 */
async function ensureWorkerStarted(port: number): Promise<boolean> {
  // Check if worker is already running and healthy
  if (await waitForHealth(port, 1000)) {
    const versionCheck = await checkVersionMatch(port);
    if (!versionCheck.matches) {
      logger.info('SYSTEM', 'Worker version mismatch detected', {
        pluginVersion: versionCheck.pluginVersion,
        workerVersion: versionCheck.workerVersion
      });

      // Verify the new native binary loads before killing the old worker.
      // If verification fails (ABI mismatch, missing module), keep the old
      // worker running — a working older version beats a broken newer one.
      if (!verifyNativeModules()) {
        logger.error('SYSTEM', 'Native module verification failed — keeping old worker running', {
          pluginVersion: versionCheck.pluginVersion,
          workerVersion: versionCheck.workerVersion
        });
        return true;
      }

      logger.info('SYSTEM', 'Native modules verified, restarting worker');
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown for version mismatch restart', { port });
        return false;
      }
      removePidFile();
    } else {
      logger.info('SYSTEM', 'Worker already running and healthy');
      return true;
    }
  }

  // Check if port is in use by something else
  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
    const healthy = await waitForHealth(port, getPlatformTimeout(15000));
    if (healthy) {
      logger.info('SYSTEM', 'Worker is now healthy');
      return true;
    }
    logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
    return false;
  }

  // Spawn new worker daemon
  logger.info('SYSTEM', 'Starting worker daemon');
  const pid = spawnDaemon(__filename, port);
  if (pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon');
    return false;
  }

  // PID file is written by the worker itself after listen() succeeds
  // This is race-free and works correctly on Windows where cmd.exe PID is useless

  const healthy = await waitForHealth(port, getPlatformTimeout(30000));
  if (!healthy) {
    removePidFile();
    logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
    return false;
  }

  logger.info('SYSTEM', 'Worker started successfully');
  return true;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const command = process.argv[2];
  const port = getWorkerPort();

  // Helper for JSON status output in 'start' command
  // Exit code 0 ensures Windows Terminal doesn't keep tabs open
  function exitWithStatus(status: 'ready' | 'error', message?: string): never {
    const output = buildStatusOutput(status, message);
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  switch (command) {
    case 'start': {
      const success = await ensureWorkerStarted(port);
      if (success) {
        exitWithStatus('ready');
      } else {
        exitWithStatus('error', 'Failed to start worker');
      }
      break;
    }

    case 'stop': {
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
      }
      removePidFile();
      logger.info('SYSTEM', 'Worker stopped successfully');
      process.exit(0);
      break;
    }

    case 'restart': {
      logger.info('SYSTEM', 'Restarting worker');
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }
      removePidFile();

      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }

      // PID file is written by the worker itself after listen() succeeds
      // This is race-free and works correctly on Windows where cmd.exe PID is useless

      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to restart');
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }

      logger.info('SYSTEM', 'Worker restarted successfully');
      process.exit(0);
      break;
    }

    case 'status': {
      const running = await isPortInUse(port);
      const pidInfo = readPidFile();
      if (running && pidInfo) {
        console.log('Worker is running');
        console.log(`  PID: ${String(pidInfo.pid)}`);
        console.log(`  Port: ${String(pidInfo.port)}`);
        console.log(`  Started: ${pidInfo.startedAt}`);
      } else {
        console.log('Worker is not running');
      }
      process.exit(0);
      break;
    }

    case 'cursor': {
      const subcommand = process.argv[3];
      const cursorResult = await handleCursorCommand(subcommand, process.argv.slice(4));
      process.exit(cursorResult);
      break;
    }

    case 'hook': {
      // Auto-start worker if not running
      const workerReady = await ensureWorkerStarted(port);
      if (!workerReady) {
        logger.warn('SYSTEM', 'Worker failed to start before hook, handler will retry');
      }

      // Existing logic unchanged
      const platform = process.argv[3];
      const event = process.argv[4];
      if (!platform || !event) {
        console.error('Usage: magic-claude-mem hook <platform> <event>');
        console.error('Platforms: claude-code, cursor, raw');
        console.error('Events: context, session-init, observation, summarize');
        process.exit(1);
      }

      // Check if worker is already running on port
      const portInUse = await isPortInUse(port);
      let startedWorkerInProcess = false;

      if (!portInUse) {
        const pinnedBinary = getWorkerNodeBinary();
        if (process.execPath !== pinnedBinary) {
          // Current Node binary differs from the one that compiled native modules.
          // Cannot start in-process — spawn daemon with the pinned binary instead.
          logger.info('SYSTEM', 'Node binary mismatch, spawning daemon with pinned binary', {
            current: process.execPath,
            pinned: pinnedBinary
          });
          const success = await ensureWorkerStarted(port);
          if (!success) {
            logger.failure('SYSTEM', 'Failed to spawn worker with pinned binary');
            process.exit(0);
          }
          // Worker is running as a separate daemon; continue as HTTP client
        } else {
          // Port free - start worker IN THIS PROCESS (no spawn!)
          // This process becomes the worker and stays alive
          try {
            logger.info('SYSTEM', 'Starting worker in-process for hook', { event });
            const worker = new WorkerService();
            await worker.start();
            startedWorkerInProcess = true;
            // Worker is now running in this process on the port
          } catch (error) {
            logger.failure('SYSTEM', 'Worker failed to start in hook', {}, error as Error);
            removePidFile();
            process.exit(0);
          }
        }
      }
      // If port in use, we'll use HTTP to the existing worker

      const { hookCommand } = await import('../cli/hook-command.js');
      // If we started the worker in this process, skip process.exit() so we stay alive as the worker
      await hookCommand(platform, event, { skipExit: startedWorkerInProcess });
      // Note: if we started worker in-process, this process stays alive as the worker
      // The break allows the event loop to continue serving requests
      break;
    }

    case '--daemon':
    default: {
      const worker = new WorkerService();
      worker.start().catch((error: unknown) => {
        logger.failure('SYSTEM', 'Worker failed to start', {}, error instanceof Error ? error : new Error(String(error)));
        removePidFile();
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      });
    }
  }
}

// Check if running as main module in both ESM and CommonJS
const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- module.parent needed for CommonJS compatibility check
  ? require.main === module || !module.parent
  : import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-service');

if (isMainModule) {
  void main();
}
