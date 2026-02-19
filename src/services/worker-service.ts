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
import { existsSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { getAuthMethodDescription } from '../shared/EnvManager.js';
import { ensureAuthToken } from '../shared/AuthTokenManager.js';
import { logger } from '../utils/logger.js';
import { ChromaMcpManager } from './sync/ChromaMcpManager.js';
import { ChromaSync } from './sync/ChromaSync.js';

// Windows: avoid repeated spawn popups when startup fails (issue #921)
const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

function getWorkerSpawnLockPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start-attempted');
}

function shouldSkipSpawnOnWindows(): boolean {
  if (process.platform !== 'win32') return false;
  const lockPath = getWorkerSpawnLockPath();
  if (!existsSync(lockPath)) return false;
  try {
    const modifiedTimeMs = statSync(lockPath).mtimeMs;
    return Date.now() - modifiedTimeMs < WINDOWS_SPAWN_COOLDOWN_MS;
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Windows lock file stat failed, treating as no lock', {}, error);
    }
    return false;
  }
}

function markWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    writeFileSync(getWorkerSpawnLockPath(), '', 'utf-8');
  } catch {
    // Best-effort lock file — failure to write shouldn't block startup
  }
}

function clearWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup
  }
}

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// Infrastructure imports
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  aggressiveStartupCleanup,
  runOneTimeChromaMigration,
  cleanStalePidFile,
  isProcessAlive,
  spawnDaemon,
  createSignalHandler
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

// Service layer imports
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { GeminiAgent, isGeminiSelected, isGeminiAvailable } from './worker/GeminiAgent.js';
import { OpenRouterAgent, isOpenRouterSelected, isOpenRouterAvailable } from './worker/OpenRouterAgent.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';
import { SearchManager } from './worker/SearchManager.js';
import { FormattingService } from './worker/FormattingService.js';
import { TimelineService } from './worker/TimelineService.js';
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';

// HTTP route handlers
import { requireBearerToken } from './worker/http/middleware.js';
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';
import { MemoryRoutes } from './worker/http/routes/MemoryRoutes.js';

// Process management for zombie cleanup (Issue #737)
import { startOrphanReaper, reapOrphanedProcesses, getProcessBySession, ensureProcessExit } from './worker/ProcessRegistry.js';

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
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private geminiAgent: GeminiAgent;
  private openRouterAgent: OpenRouterAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
  private sessionEventBroadcaster: SessionEventBroadcaster;

  // Route handlers
  private searchRoutes: SearchRoutes | null = null;

  // Chroma MCP manager (lazy - connects on first use)
  private chromaMcpManager: ChromaMcpManager | null = null;

  // Initialization tracking
  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

  // Orphan reaper cleanup function (Issue #737)
  private stopOrphanReaper: (() => void) | null = null;

  // Stale session reaper interval (Issue #1168)
  private staleSessionReaperInterval: ReturnType<typeof setInterval> | null = null;

  // AI interaction tracking for health endpoint
  private lastAiInteraction: {
    timestamp: number;
    success: boolean;
    provider: string;
    error?: string;
  } | null = null;

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
    this.openRouterAgent = new OpenRouterAgent(this.dbManager, this.sessionManager);

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
      onRestart: () => this.shutdown(),
      workerPath: __filename,
      getAiStatus: () => {
        let provider = 'claude';
        if (isOpenRouterSelected() && isOpenRouterAvailable()) provider = 'openrouter';
        else if (isGeminiSelected() && isGeminiAvailable()) provider = 'gemini';
        return {
          provider,
          authMethod: getAuthMethodDescription(),
          lastInteraction: this.lastAiInteraction
            ? {
                timestamp: this.lastAiInteraction.timestamp,
                success: this.lastAiInteraction.success,
                ...(this.lastAiInteraction.error && { error: this.lastAiInteraction.error }),
              }
            : null,
        };
      },
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
      handler('SIGTERM');
    });
    process.on('SIGINT', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGINT');
    });

    // SIGHUP: sent by kernel when controlling terminal closes.
    // Daemon mode: ignore it (survive parent shell exit).
    // Interactive mode: treat like SIGTERM (graceful shutdown).
    if (process.platform !== 'win32') {
      if (process.argv.includes('--daemon')) {
        process.on('SIGHUP', () => {
          logger.debug('SYSTEM', 'Ignoring SIGHUP in daemon mode');
        });
      } else {
        process.on('SIGHUP', () => {
          this.isShuttingDown = shutdownRef.value;
          handler('SIGHUP');
        });
      }
    }
  }

  /**
   * Register all route handlers with the server
   */
  private registerRoutes(): void {
    // IMPORTANT: Middleware must be registered BEFORE routes (Express processes in order)

    // Bearer token authentication — protects all routes except health/readiness
    const authToken = ensureAuthToken();
    this.server.app.use(requireBearerToken(authToken));

    // Early handler for /api/context/inject — fail open if not yet initialized
    this.server.app.get('/api/context/inject', async (req, res, next) => {
      if (!this.initializationCompleteFlag || !this.searchRoutes) {
        logger.warn('SYSTEM', 'Context requested before initialization complete, returning empty');
        res.status(200).json({ content: [{ type: 'text', text: '' }] });
        return;
      }

      next(); // Delegate to SearchRoutes handler
    });

    // Guard ALL /api/* routes during initialization — wait for DB with timeout
    // Exceptions: /api/health, /api/readiness, /api/version (handled by Server.ts core routes)
    // and /api/context/inject (handled above with fail-open)
    this.server.app.use('/api', async (req, res, next) => {
      if (this.initializationCompleteFlag) {
        next();
        return;
      }

      const timeoutMs = 30000;
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Database initialization timeout')), timeoutMs)
      );

      try {
        await Promise.race([this.initializationComplete, timeoutPromise]);
        next();
      } catch (error) {
        const isTimeout = error instanceof Error && error.message.includes('initialization timeout');
        if (isTimeout) {
          logger.warn('HTTP', `Request to ${req.method} ${req.path} timed out waiting for DB initialization`, {}, error as Error);
        } else {
          logger.error('HTTP', `Request to ${req.method} ${req.path} rejected — initialization failed unexpectedly`, {}, error as Error);
        }
        res.status(503).json({
          error: 'Service initializing',
          message: 'Database is still initializing, please retry'
        });
        return;
      }
    });

    // Standard routes (registered AFTER guard middleware)
    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));
    this.server.registerRoutes(new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.sessionEventBroadcaster, this));
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));
    this.server.registerRoutes(new LogsRoutes());
    this.server.registerRoutes(new MemoryRoutes(this.dbManager, 'claude-mem'));
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
      startedAt: new Date().toISOString()
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
      await aggressiveStartupCleanup();

      // Load mode configuration
      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

      // One-time chroma wipe for users upgrading from versions with duplicate worker bugs.
      // Only runs in local mode (chroma is local-only). Backfill at line ~414 rebuilds from SQLite.
      if (settings.CLAUDE_MEM_MODE === 'local' || !settings.CLAUDE_MEM_MODE) {
        runOneTimeChromaMigration();
      }

      // Initialize ChromaMcpManager (lazy - connects on first use via ChromaSync)
      this.chromaMcpManager = ChromaMcpManager.getInstance();
      logger.info('SYSTEM', 'ChromaMcpManager initialized (lazy - connects on first use)');

      const modeId = settings.CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      await this.dbManager.initialize();

      // Reset any messages that were processing when worker died
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
      const resetCount = pendingStore.resetStaleProcessingMessages(0); // 0 = reset ALL processing
      if (resetCount > 0) {
        logger.info('SYSTEM', `Reset ${resetCount} stale processing messages to pending`);
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

      // Auto-backfill Chroma for all projects if out of sync with SQLite (fire-and-forget)
      if (this.chromaMcpManager) {
        ChromaSync.backfillAllProjects().then(() => {
          logger.info('CHROMA_SYNC', 'Backfill check complete for all projects');
        }).catch(error => {
          logger.error('CHROMA_SYNC', 'Backfill failed (non-blocking)', {}, error as Error);
        });
      }

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env: process.env
      });

      const MCP_INIT_TIMEOUT_MS = 300000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
      );

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Background initialization complete');

      // Start orphan reaper to clean up zombie processes (Issue #737)
      this.stopOrphanReaper = startOrphanReaper(() => {
        const activeIds = new Set<number>();
        for (const [id] of this.sessionManager['sessions']) {
          activeIds.add(id);
        }
        return activeIds;
      });
      logger.info('SYSTEM', 'Started orphan reaper (runs every 5 minutes)');

      // Reap stale sessions to unblock orphan process cleanup (Issue #1168)
      this.staleSessionReaperInterval = setInterval(async () => {
        try {
          const reaped = await this.sessionManager.reapStaleSessions();
          if (reaped > 0) {
            logger.info('SYSTEM', `Reaped ${reaped} stale sessions`);
          }
        } catch (e) {
          if (e instanceof Error) {
            logger.error('SYSTEM', 'Stale session reaper failed — will retry on next interval', {}, e);
          }
          return;
        }
      }, 2 * 60 * 1000);

      // Auto-recover orphaned queues (fire-and-forget with error logging)
      this.processPendingQueues(50).then(result => {
        if (result.sessionsStarted > 0) {
          logger.info('SYSTEM', `Auto-recovered ${result.sessionsStarted} sessions with pending work`, {
            totalPending: result.totalPendingSessions,
            started: result.sessionsStarted,
            sessionIds: result.startedSessionIds
          });
        }
      }).catch(error => {
        logger.error('SYSTEM', 'Auto-recovery of pending queues failed', {}, error as Error);
      });
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      throw error;
    }
  }

  /**
   * Get the appropriate agent based on provider settings.
   * Same logic as SessionRoutes.getActiveAgent() for consistency.
   */
  private getActiveAgent(): SDKAgent | GeminiAgent | OpenRouterAgent {
    if (isOpenRouterSelected() && isOpenRouterAvailable()) {
      return this.openRouterAgent;
    }
    if (isGeminiSelected() && isGeminiAvailable()) {
      return this.geminiAgent;
    }
    return this.sdkAgent;
  }

  /**
   * Start a session processor
   * On SDK resume failure (terminated session), falls back to Gemini/OpenRouter if available,
   * otherwise marks messages abandoned and removes session so queue does not grow unbounded.
   */
  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string
  ): void {
    if (!session) return;

    const sid = session.sessionDbId;
    const agent = this.getActiveAgent();
    const providerName = agent.constructor.name;

    // Before starting generator, check if AbortController is already aborted
    // This can happen after a previous generator was aborted but the session still has pending work
    if (session.abortController.signal.aborted) {
      logger.debug('SYSTEM', 'Replacing aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    // Track whether generator failed with an unrecoverable error to prevent infinite restart loops
    let hadUnrecoverableError = false;
    let sessionFailed = false;

    logger.info('SYSTEM', `Starting generator (${source}) using ${providerName}`, { sessionId: sid });

    session.generatorPromise = agent.startSession(session, this)
      .catch(async (error: unknown) => {
        const errorMessage = (error as Error)?.message || '';

        // Detect unrecoverable errors that should NOT trigger restart
        // These errors will fail immediately on retry, causing infinite loops
        const unrecoverablePatterns = [
          'Claude executable not found',
          'CLAUDE_CODE_PATH',
          'ENOENT',
          'spawn',
          'Invalid API key',
        ];
        if (unrecoverablePatterns.some(pattern => errorMessage.includes(pattern))) {
          hadUnrecoverableError = true;
          this.lastAiInteraction = {
            timestamp: Date.now(),
            success: false,
            provider: providerName,
            error: errorMessage,
          };
          logger.error('SDK', 'Unrecoverable generator error - will NOT restart', {
            sessionId: session.sessionDbId,
            project: session.project,
            errorMessage
          });
          return;
        }

        // Fallback for terminated SDK sessions (provider abstraction)
        if (this.isSessionTerminatedError(error)) {
          logger.warn('SDK', 'SDK resume failed, falling back to standalone processing', {
            sessionId: session.sessionDbId,
            project: session.project,
            reason: error instanceof Error ? error.message : String(error)
          });
          return this.runFallbackForTerminatedSession(session, error);
        }

        // Detect stale resume failures - SDK session context was lost.
        // String matching is required here: the Claude CLI SDK emits plain Error objects
        // without .code properties for these conditions — no typed error classes exist.
        const isStaleResumeFailure = error instanceof Error
          // [ANTI-PATTERN IGNORED]: Claude CLI SDK emits plain Error objects without .code — string matching required
          && (errorMessage.includes('aborted by user') || errorMessage.includes('No conversation found'));
        if (isStaleResumeFailure && session.memorySessionId) {
          logger.warn('SDK', 'Detected stale resume failure, clearing memorySessionId for fresh start', {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            errorMessage
          });
          // Clear stale memorySessionId and force fresh init on next attempt
          this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
          session.memorySessionId = null;
          session.forceInit = true;
        }
        logger.error('SDK', 'Session generator failed', {
          sessionId: session.sessionDbId,
          project: session.project,
          provider: providerName
        }, error as Error);
        sessionFailed = true;
        this.lastAiInteraction = {
          timestamp: Date.now(),
          success: false,
          provider: providerName,
          error: errorMessage,
        };
        throw error;
      })
      .finally(async () => {
        // CRITICAL: Verify subprocess exit to prevent zombie accumulation (Issue #1168)
        const trackedProcess = getProcessBySession(session.sessionDbId);
        if (trackedProcess && !trackedProcess.process.killed && trackedProcess.process.exitCode === null) {
          await ensureProcessExit(trackedProcess, 5000);
        }

        session.generatorPromise = null;

        // Record successful AI interaction if no error occurred
        if (!sessionFailed && !hadUnrecoverableError) {
          this.lastAiInteraction = {
            timestamp: Date.now(),
            success: true,
            provider: providerName,
          };
        }

        // Do NOT restart after unrecoverable errors - prevents infinite loops
        if (hadUnrecoverableError) {
          logger.warn('SYSTEM', 'Skipping restart due to unrecoverable error', {
            sessionId: session.sessionDbId
          });
          this.broadcastProcessingStatus();
          return;
        }

        // Store for pending-count check below
        const { PendingMessageStore } = require('./sqlite/PendingMessageStore.js');
        const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

        // Idle timeout means no new work arrived for 3 minutes - don't restart
        // No need to reset stale processing messages here — claimNextMessage() self-heals
        if (session.idleTimedOut) {
          logger.info('SYSTEM', 'Generator exited due to idle timeout, not restarting', {
            sessionId: session.sessionDbId
          });
          session.idleTimedOut = false; // Reset flag
          this.broadcastProcessingStatus();
          return;
        }

        // Check if there's pending work that needs processing with a fresh AbortController
        const pendingCount = pendingStore.getPendingCount(session.sessionDbId);

        if (pendingCount > 0) {
          logger.info('SYSTEM', 'Pending work remains after generator exit, restarting with fresh AbortController', {
            sessionId: session.sessionDbId,
            pendingCount
          });
          // Reset AbortController for restart
          session.abortController = new AbortController();
          // Restart processor
          this.startSessionProcessor(session, 'pending-work-restart');
        }

        this.broadcastProcessingStatus();
      });
  }

  /**
   * Match errors that indicate the Claude Code process/session is gone (resume impossible).
   * Used to trigger graceful fallback instead of leaving pending messages stuck forever.
   */
  private isSessionTerminatedError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const normalized = msg.toLowerCase();
    return (
      normalized.includes('process aborted by user') ||
      normalized.includes('processtransport') ||
      normalized.includes('not ready for writing') ||
      normalized.includes('session generator failed') ||
      normalized.includes('claude code process')
    );
  }

  /**
   * When SDK resume fails due to terminated session: try Gemini then OpenRouter to drain
   * pending messages; if no fallback available, mark messages abandoned and remove session.
   */
  private async runFallbackForTerminatedSession(
    session: ReturnType<typeof this.sessionManager.getSession>,
    _originalError: unknown
  ): Promise<void> {
    if (!session) return;

    const sessionDbId = session.sessionDbId;

    // Fallback agents need memorySessionId for storeObservations
    if (!session.memorySessionId) {
      const syntheticId = `fallback-${sessionDbId}-${Date.now()}`;
      session.memorySessionId = syntheticId;
      this.dbManager.getSessionStore().updateMemorySessionId(sessionDbId, syntheticId);
    }

    if (isGeminiAvailable()) {
      try {
        await this.geminiAgent.startSession(session, this);
        return;
      } catch (e) {
        // [ANTI-PATTERN IGNORED]: Must continue to try next fallback agent (OpenRouter)
        if (e instanceof Error) {
          logger.warn('SDK', 'Fallback Gemini failed, trying OpenRouter', { sessionId: sessionDbId }, e);
        }
      }
    }

    if (isOpenRouterAvailable()) {
      try {
        await this.openRouterAgent.startSession(session, this);
        return;
      } catch (e) {
        // [ANTI-PATTERN IGNORED]: Falls through to abandon messages and cleanup below
        if (e instanceof Error) {
          logger.warn('SDK', 'Fallback OpenRouter failed — no fallback agents remaining', { sessionId: sessionDbId }, e);
        }
      }
    }

    // No fallback or both failed: mark messages abandoned and remove session so queue doesn't grow
    const pendingStore = this.sessionManager.getPendingMessageStore();
    const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
    if (abandoned > 0) {
      logger.warn('SDK', 'No fallback available; marked pending messages abandoned', {
        sessionId: sessionDbId,
        abandoned
      });
    }
    this.sessionManager.removeSessionImmediate(sessionDbId);
    this.sessionEventBroadcaster.broadcastSessionCompleted(sessionDbId);
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
    const sessionStore = this.dbManager.getSessionStore();

    // Clean up stale 'active' sessions before processing
    // Sessions older than 6 hours without activity are likely orphaned
    const STALE_SESSION_THRESHOLD_MS = 6 * 60 * 60 * 1000;
    const staleThreshold = Date.now() - STALE_SESSION_THRESHOLD_MS;

    let staleSessionIds: { id: number }[] = [];
    try {
      staleSessionIds = sessionStore.db.prepare(`
        SELECT id FROM sdk_sessions
        WHERE status = 'active' AND started_at_epoch < ?
      `).all(staleThreshold) as { id: number }[];
    } catch (error) {
      // [ANTI-PATTERN IGNORED]: Stale session cleanup is best-effort — failure shouldn't block orphan processing
      if (error instanceof Error) {
        logger.error('SYSTEM', 'Failed to query stale sessions', {}, error);
      }
    }

    if (staleSessionIds.length > 0) {
      const ids = staleSessionIds.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const updateSessionsSql = `UPDATE sdk_sessions SET status = 'failed', completed_at_epoch = ? WHERE id IN (${placeholders})`;
      const updateMessagesSql = `UPDATE pending_messages SET status = 'failed', failed_at_epoch = ? WHERE status = 'pending' AND session_db_id IN (${placeholders})`;

      try {
        sessionStore.db.prepare(updateSessionsSql).run(Date.now(), ...ids);
        logger.info('SYSTEM', `Marked ${ids.length} stale sessions as failed`);
        const msgResult = sessionStore.db.prepare(updateMessagesSql).run(Date.now(), ...ids);
        if (msgResult.changes > 0) {
          logger.info('SYSTEM', `Marked ${msgResult.changes} pending messages from stale sessions as failed`);
        }
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Best-effort stale session cleanup — failure shouldn't block orphan processing
        if (error instanceof Error) {
          logger.error('SYSTEM', 'Failed to mark stale sessions as failed', { staleSessionIds: ids }, error);
        }
      }
    }

    const orphanedSessionIds = pendingStore.getSessionsWithPendingMessages();

    const result = {
      totalPendingSessions: orphanedSessionIds.length,
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[]
    };

    if (orphanedSessionIds.length === 0) return result;

    logger.info('SYSTEM', `Processing up to ${sessionLimit} of ${orphanedSessionIds.length} pending session queues`);

    for (const sessionDbId of orphanedSessionIds) {
      if (result.sessionsStarted >= sessionLimit) break;

      const existingSession = this.sessionManager.getSession(sessionDbId);
      if (existingSession?.generatorPromise) {
        result.sessionsSkipped++;
        continue;
      }

      let session: ReturnType<typeof this.sessionManager.initializeSession>;
      try {
        session = this.sessionManager.initializeSession(sessionDbId);
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Loop iteration — continue to next session after logging
        if (error instanceof Error) {
          logger.error('SYSTEM', `Failed to initialize session ${sessionDbId}`, {}, error);
        }
        result.sessionsSkipped++;
        continue;
      }

      logger.info('SYSTEM', `Starting processor for session ${sessionDbId}`, {
        project: session.project,
        pendingCount: pendingStore.getPendingCount(sessionDbId)
      });

      this.startSessionProcessor(session, 'startup-recovery');
      result.sessionsStarted++;
      result.startedSessionIds.push(sessionDbId);

      await new Promise(resolve => setTimeout(resolve, 100));
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

    // Stop stale session reaper (Issue #1168)
    if (this.staleSessionReaperInterval) {
      clearInterval(this.staleSessionReaperInterval);
      this.staleSessionReaperInterval = null;
    }

    await performGracefulShutdown({
      server: this.server.getHttpServer(),
      sessionManager: this.sessionManager,
      mcpClient: this.mcpClient,
      dbManager: this.dbManager,
      chromaMcpManager: this.chromaMcpManager || undefined
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
export async function ensureWorkerStarted(port: number): Promise<boolean> {
  // Clean stale PID file first (cheap: 1 fs read + 1 signal-0 check)
  cleanStalePidFile();

  // Check if worker is already running and healthy
  if (await waitForHealth(port, 1000)) {
    const versionCheck = await checkVersionMatch(port);
    if (!versionCheck.matches) {
      logger.info('SYSTEM', 'Worker version mismatch detected - auto-restarting', {
        pluginVersion: versionCheck.pluginVersion,
        workerVersion: versionCheck.workerVersion
      });

      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
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
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      logger.info('SYSTEM', 'Worker is now healthy');
      return true;
    }
    logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
    return false;
  }

  // Windows: skip spawn if a recent attempt already failed (prevents repeated bun.exe popups, issue #921)
  if (shouldSkipSpawnOnWindows()) {
    logger.warn('SYSTEM', 'Worker unavailable on Windows — skipping spawn (recent attempt failed within cooldown)');
    return false;
  }

  // Spawn new worker daemon
  logger.info('SYSTEM', 'Starting worker daemon');
  markWorkerSpawnAttempted();
  const pid = spawnDaemon(__filename, port);
  if (pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon');
    return false;
  }

  // PID file is written by the worker itself after listen() succeeds
  // This is race-free and works correctly on Windows where cmd.exe PID is useless

  const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
  if (!healthy) {
    removePidFile();
    logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
    return false;
  }

  clearWorkerSpawnAttempted();
  logger.info('SYSTEM', 'Worker started successfully');
  return true;
}

