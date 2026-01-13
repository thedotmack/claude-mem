/**
 * Worker Service - Slim Orchestrator
 *
 * WHAT: Main entry point and orchestrator for the claude-mem background worker process.
 * WHY: Claude-mem requires a persistent background service to handle AI processing,
 *      database operations, and SSE broadcasting without blocking the IDE/CLI hooks.
 *
 * Refactored from 2000-line monolith to ~300-line orchestrator.
 * Delegates to specialized modules:
 * - src/services/server/ - HTTP server, middleware, error handling
 * - src/services/infrastructure/ - Process management, health monitoring, shutdown
 * - src/services/integrations/ - IDE integrations (Cursor)
 * - src/services/worker/ - Business logic, routes, agents
 */

// WHAT: Imports Node.js path module for cross-platform file path manipulation
// WHY: Worker needs to resolve paths to MCP server script and other resources
import path from 'path';

// WHAT: Imports Node.js filesystem module (namespace import for tree-shaking)
// WHY: Used for file operations like reading/writing settings during setup wizard
import * as fs from 'fs';

// WHAT: Imports child_process spawn for creating subprocess
// WHY: Worker spawns MCP server as a child process for memory search functionality
import { spawn } from 'child_process';

// WHAT: Imports os.homedir() to get user's home directory path
// WHY: Settings and data files are stored in ~/.claude-mem/ directory
import { homedir } from 'os';

// WHAT: Imports specific fs functions for synchronous file operations
// WHY: Setup wizard and config loading use sync operations for simpler control flow
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';

// WHAT: Imports readline module for interactive terminal input
// WHY: Setup wizard prompts user for configuration choices via stdin/stdout
import * as readline from 'readline';

// WHAT: Imports MCP (Model Context Protocol) client for connecting to MCP servers
// WHY: Worker acts as MCP client to communicate with the memory search MCP server
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// WHAT: Imports stdio transport for MCP communication over stdin/stdout
// WHY: MCP server runs as subprocess, communicating via standard streams
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// WHAT: Imports port and host configuration getters from shared utilities
// WHY: Worker port (default 37777) is configurable; centralized for consistency
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';

// WHAT: Imports centralized logging utility with structured output
// WHY: All worker logs go through this for consistent formatting and log levels
import { logger } from '../utils/logger.js';

// ============================================================================
// Infrastructure imports - Process lifecycle and health management
// ============================================================================

// WHAT: Imports PID file management functions for daemon process tracking
// WHY: PID file at ~/.claude-mem/worker.pid tracks running worker for stop/restart commands
import {
  writePidFile,      // WHAT: Writes process info to PID file; WHY: Enables stop/restart commands to find the worker
  readPidFile,       // WHAT: Reads PID file to get running worker info; WHY: Status command reports process details
  removePidFile,     // WHAT: Deletes PID file; WHY: Cleanup on shutdown prevents stale PID references
  getPlatformTimeout,// WHAT: Adjusts timeout values for different OS; WHY: Windows needs longer timeouts for process operations
  cleanupOrphanedProcesses, // WHAT: Kills stale worker processes; WHY: Prevents port conflicts from crashed workers
  spawnDaemon,       // WHAT: Spawns worker as detached background process; WHY: Worker runs independently of CLI/IDE
  createSignalHandler // WHAT: Creates SIGTERM/SIGINT handler; WHY: Enables graceful shutdown on Ctrl+C or kill
} from './infrastructure/ProcessManager.js';

// WHAT: Imports health monitoring functions for worker lifecycle
// WHY: Start command needs to verify worker is responsive before returning success
import {
  isPortInUse,       // WHAT: Checks if TCP port has active listener; WHY: Detects if worker already running
  waitForHealth,     // WHAT: Polls /health endpoint until responsive; WHY: Confirms worker fully initialized
  waitForPortFree,   // WHAT: Waits for port to become available; WHY: Restart command needs port free before respawn
  httpShutdown,      // WHAT: Sends POST /shutdown to worker; WHY: Graceful shutdown via HTTP request
  checkVersionMatch  // WHAT: Compares plugin version with running worker; WHY: Auto-restart on version mismatch
} from './infrastructure/HealthMonitor.js';

// WHAT: Imports graceful shutdown orchestrator
// WHY: Shutdown must close connections, flush queues, and cleanup in correct order
import { performGracefulShutdown } from './infrastructure/GracefulShutdown.js';

// ============================================================================
// Server imports - HTTP server infrastructure
// ============================================================================

// WHAT: Imports HTTP server wrapper class
// WHY: Server class encapsulates Express app setup, middleware, and route registration
import { Server } from './server/Server.js';

// ============================================================================
// Integration imports - IDE-specific functionality
// ============================================================================

// WHAT: Imports Cursor IDE integration functions
// WHY: Claude-mem supports Cursor as well as Claude Code; these handle Cursor-specific setup
import {
  updateCursorContextForProject, // WHAT: Updates CLAUDE.md context for Cursor projects; WHY: Context injection for Cursor users
  handleCursorCommand,           // WHAT: Handles 'cursor' CLI subcommands; WHY: CLI command routing
  detectClaudeCode,              // WHAT: Checks if Claude Code is installed; WHY: Setup wizard recommends Claude SDK if available
  findCursorHooksDir,            // WHAT: Locates cursor-hooks build directory; WHY: Installer needs hook scripts path
  installCursorHooks,            // WHAT: Copies hooks to Cursor config; WHY: Enables claude-mem in Cursor
  configureCursorMcp             // WHAT: Adds MCP server to Cursor config; WHY: Enables memory search in Cursor
} from './integrations/CursorHooksInstaller.js';

// ============================================================================
// Service layer imports - Core business logic
// ============================================================================

// WHAT: Imports database manager for SQLite operations
// WHY: All persistent data (sessions, observations, settings) stored in SQLite
import { DatabaseManager } from './worker/DatabaseManager.js';

// WHAT: Imports session manager for tracking active sessions
// WHY: Each IDE session has state (queue, generator promise) that needs management
import { SessionManager } from './worker/SessionManager.js';

// WHAT: Imports Server-Sent Events broadcaster for real-time updates
// WHY: Viewer UI receives live updates (new observations, processing status) via SSE
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';

// WHAT: Imports Claude SDK agent for AI processing
// WHY: Default AI provider using Claude's official SDK for observation compression
import { SDKAgent } from './worker/SDKAgent.js';

// WHAT: Imports Gemini agent as alternative AI provider
// WHY: Users without Claude Code subscription can use Gemini (1500 free requests/day)
import { GeminiAgent } from './worker/GeminiAgent.js';

// WHAT: Imports OpenRouter agent as another alternative AI provider
// WHY: OpenRouter provides access to 100+ models including free options
import { OpenRouterAgent } from './worker/OpenRouterAgent.js';

// WHAT: Imports pagination helper for database queries
// WHY: Viewer UI needs paginated results for large observation lists
import { PaginationHelper } from './worker/PaginationHelper.js';

// WHAT: Imports settings manager for user configuration
// WHY: Settings (provider, API keys, mode) are managed through HTTP API
import { SettingsManager } from './worker/SettingsManager.js';

// WHAT: Imports search manager for memory search operations
// WHY: MCP search tool and API endpoints delegate to this for query handling
import { SearchManager } from './worker/SearchManager.js';

// WHAT: Imports formatting service for search result presentation
// WHY: Search results need consistent formatting for CLAUDE.md injection
import { FormattingService } from './worker/FormattingService.js';

// WHAT: Imports timeline service for context window queries
// WHY: Timeline queries show observations around a specific point in time
import { TimelineService } from './worker/TimelineService.js';

// WHAT: Imports session event broadcaster for SSE session events
// WHY: UI needs notifications when sessions start/end/update
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';

// ============================================================================
// HTTP route handler imports - REST API endpoints
// ============================================================================

// WHAT: Imports viewer-related routes (SSE stream, static files)
// WHY: Viewer UI at localhost:37777 needs these endpoints
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';

// WHAT: Imports session management routes (create, end, list)
// WHY: Hooks call these to register sessions and post observations
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';

// WHAT: Imports data retrieval routes (observations, statistics)
// WHY: Viewer UI and MCP tools query data through these endpoints
import { DataRoutes } from './worker/http/routes/DataRoutes.js';

// WHAT: Imports search routes (full-text, semantic, timeline)
// WHY: MCP search tool and viewer search box use these endpoints
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';

// WHAT: Imports settings routes (get/set configuration)
// WHY: Viewer UI settings panel uses these endpoints
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';

// WHAT: Imports log viewer routes
// WHY: Viewer UI can display worker logs for debugging
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';

// WHAT: Re-exports updateCursorContextForProject for SDK agents
// WHY: SDK agents need to trigger context updates after processing; avoids circular imports
export { updateCursorContextForProject };

// ============================================================================
// Status Output Types - Hook Framework Communication
// ============================================================================

/**
 * WHAT: Defines the JSON structure for hook framework status responses
 * WHY: Hooks expect structured JSON output to determine if startup succeeded
 *      - continue: true - tells hook framework to proceed
 *      - suppressOutput: true - prevents JSON from appearing in IDE
 *      - status: 'ready'|'error' - indicates success or failure
 *      - message: optional error details for debugging
 */
export interface StatusOutput {
  continue: true;
  suppressOutput: true;
  status: 'ready' | 'error';
  message?: string;
}

/**
 * WHAT: Pure function to build JSON status output for hook framework
 * WHY: Extracted as pure function for testability and consistent output format
 *
 * @param status - 'ready' for successful startup, 'error' for failures
 * @param message - Optional error message (only included when provided)
 * @returns JSON object with continue, suppressOutput, status, and optionally message
 */
export function buildStatusOutput(status: 'ready' | 'error', message?: string): StatusOutput {
  // WHAT: Returns object with spread for conditional message inclusion
  // WHY: Only include message field when it has a value (cleaner JSON output)
  return {
    continue: true,
    suppressOutput: true,
    status,
    ...(message && { message })
  };
}

// ============================================================================
// WorkerService Class - Main Orchestrator
// ============================================================================

/**
 * WHAT: Main worker service class that orchestrates all worker functionality
 * WHY: Encapsulates initialization, routing, and lifecycle management in one place
 */
export class WorkerService {
  // WHAT: HTTP server instance wrapping Express
  // WHY: Server handles all HTTP requests from hooks, viewer, and MCP tools
  private server: Server;

  // WHAT: Timestamp of when worker started (milliseconds since epoch)
  // WHY: Used for uptime calculation in /health endpoint
  private startTime: number = Date.now();

  // WHAT: MCP client for communicating with memory search MCP server
  // WHY: Worker proxies MCP requests to the search server subprocess
  private mcpClient: Client;

  // ============================================================================
  // Initialization flags - Track async startup progress
  // ============================================================================

  // WHAT: Flag indicating MCP client connected successfully
  // WHY: Some endpoints need MCP; flag allows graceful degradation if not ready
  private mcpReady: boolean = false;

  // WHAT: Flag indicating all background initialization complete
  // WHY: /health endpoint reports different status during initialization
  private initializationCompleteFlag: boolean = false;

  // WHAT: Flag to prevent duplicate shutdown attempts
  // WHY: SIGTERM/SIGINT can arrive multiple times; only shutdown once
  private isShuttingDown: boolean = false;

  // ============================================================================
  // Service layer instances - Business logic components
  // ============================================================================

  // WHAT: Database manager instance for SQLite operations
  // WHY: Single instance ensures connection pooling and consistent state
  private dbManager: DatabaseManager;

  // WHAT: Session manager for tracking active IDE sessions
  // WHY: Each session has queue state; manager ensures no duplicates
  private sessionManager: SessionManager;

  // WHAT: SSE broadcaster for real-time UI updates
  // WHY: Viewer UI subscribes to SSE stream for live observation updates
  private sseBroadcaster: SSEBroadcaster;

  // WHAT: Claude SDK agent for AI processing (default provider)
  // WHY: Primary agent using Claude API via SDK for observation compression
  private sdkAgent: SDKAgent;

  // WHAT: Gemini agent as alternative AI provider
  // WHY: Free tier users can use Gemini instead of Claude SDK
  private geminiAgent: GeminiAgent;

  // WHAT: OpenRouter agent as another alternative AI provider
  // WHY: Users wanting other models (GPT-4, Mixtral, etc.) use OpenRouter
  private openRouterAgent: OpenRouterAgent;

  // WHAT: Pagination helper for database queries
  // WHY: Large result sets need pagination; helper handles offset/limit logic
  private paginationHelper: PaginationHelper;

  // WHAT: Settings manager for user configuration
  // WHY: Manages ~/.claude-mem/settings.json read/write operations
  private settingsManager: SettingsManager;

  // WHAT: Session event broadcaster for SSE session notifications
  // WHY: UI needs to know when sessions start/stop for live updates
  private sessionEventBroadcaster: SessionEventBroadcaster;

  // ============================================================================
  // Route handlers - Initialized during background init
  // ============================================================================

  // WHAT: Search routes handler, nullable because initialized asynchronously
  // WHY: SearchRoutes needs SearchManager which needs database; initialized after DB ready
  private searchRoutes: SearchRoutes | null = null;

  // ============================================================================
  // Initialization tracking - Promise-based coordination
  // ============================================================================

  // WHAT: Promise that resolves when background initialization completes
  // WHY: Some endpoints need to wait for full initialization before responding
  private initializationComplete: Promise<void>;

  // WHAT: Resolver function to complete initializationComplete promise
  // WHY: Background init calls this when done; endpoints await the promise
  private resolveInitialization!: () => void;

  /**
   * WHAT: Constructor initializes all service instances and registers routes
   * WHY: Eager initialization of non-async components allows fast startup
   */
  constructor() {
    // WHAT: Creates promise with externally-accessible resolver
    // WHY: Background init runs async; other code awaits this promise
    this.initializationComplete = new Promise((resolve) => {
      this.resolveInitialization = resolve;
    });

    // WHAT: Initialize database manager (connection opened later in initializeBackground)
    // WHY: Database path resolution doesn't require async, just connection opening
    this.dbManager = new DatabaseManager();

    // WHAT: Initialize session manager with database reference
    // WHY: Session manager needs DB to persist session metadata
    this.sessionManager = new SessionManager(this.dbManager);

    // WHAT: Initialize SSE broadcaster (no dependencies)
    // WHY: SSE clients can connect before background init completes
    this.sseBroadcaster = new SSEBroadcaster();

    // WHAT: Initialize Claude SDK agent with DB and session manager
    // WHY: SDK agent is primary AI provider; needs DB for storing compressed observations
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);

    // WHAT: Initialize Gemini agent and set SDK agent as fallback
    // WHY: If Gemini fails, falls back to Claude SDK (if available)
    this.geminiAgent = new GeminiAgent(this.dbManager, this.sessionManager);
    this.geminiAgent.setFallbackAgent(this.sdkAgent);

    // WHAT: Initialize OpenRouter agent and set SDK agent as fallback
    // WHY: If OpenRouter fails, falls back to Claude SDK (if available)
    this.openRouterAgent = new OpenRouterAgent(this.dbManager, this.sessionManager);
    this.openRouterAgent.setFallbackAgent(this.sdkAgent);

    // WHAT: Initialize pagination helper with database reference
    // WHY: Pagination queries need DB access
    this.paginationHelper = new PaginationHelper(this.dbManager);

    // WHAT: Initialize settings manager with database reference
    // WHY: Some settings are stored in DB (alongside file-based settings)
    this.settingsManager = new SettingsManager(this.dbManager);

    // WHAT: Initialize session event broadcaster with SSE and worker reference
    // WHY: Broadcasts session state changes to connected SSE clients
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);

    // WHAT: Register callback for session deletion events
    // WHY: When session deleted, UI needs processing status update
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // WHAT: Initialize MCP client with name and version metadata
    // WHY: MCP protocol requires client identification for handshake
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
    }, { capabilities: {} });

    // WHAT: Initialize HTTP server with lifecycle callbacks
    // WHY: Server needs to trigger shutdown/restart on those endpoints
    this.server = new Server({
      getInitializationComplete: () => this.initializationCompleteFlag,
      getMcpReady: () => this.mcpReady,
      onShutdown: () => this.shutdown(),
      onRestart: () => this.shutdown()
    });

    // WHAT: Register route handlers with the HTTP server
    // WHY: Routes must be registered before server starts listening
    this.registerRoutes();

    // WHAT: Register signal handlers for SIGTERM/SIGINT
    // WHY: Enables graceful shutdown on Ctrl+C or process termination
    this.registerSignalHandlers();
  }

  /**
   * WHAT: Registers SIGTERM and SIGINT handlers for graceful shutdown
   * WHY: Process can be terminated by OS or user; must cleanup properly
   */
  private registerSignalHandlers(): void {
    // WHAT: Create reference object for shutdown flag
    // WHY: Signal handler needs mutable reference to track state across calls
    const shutdownRef = { value: this.isShuttingDown };

    // WHAT: Create signal handler function with shutdown callback
    // WHY: Handler prevents duplicate shutdowns and logs signal reception
    const handler = createSignalHandler(() => this.shutdown(), shutdownRef);

    // WHAT: Register SIGTERM handler (sent by kill command or systemd)
    // WHY: SIGTERM is standard graceful termination signal on Unix
    process.on('SIGTERM', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGTERM');
    });

    // WHAT: Register SIGINT handler (sent by Ctrl+C)
    // WHY: SIGINT is interactive interrupt signal from terminal
    process.on('SIGINT', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGINT');
    });
  }

  /**
   * WHAT: Registers all route handler classes with the HTTP server
   * WHY: Modular route handlers keep code organized; registration centralizes routing
   */
  private registerRoutes(): void {
    // WHAT: Register viewer routes (SSE stream, static files)
    // WHY: Viewer UI needs SSE endpoint and static file serving
    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));

    // WHAT: Register session routes (create, end, observation, summarize)
    // WHY: Hooks call these endpoints to record IDE activity
    this.server.registerRoutes(new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.sessionEventBroadcaster, this));

    // WHAT: Register data routes (observations, statistics, health)
    // WHY: Viewer UI and MCP tools query data through these endpoints
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));

    // WHAT: Register settings routes (get/set configuration)
    // WHY: Viewer UI settings panel and CLI use these endpoints
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));

    // WHAT: Register log routes (log file viewing)
    // WHY: Viewer UI can display worker logs for debugging
    this.server.registerRoutes(new LogsRoutes());

    // WHAT: Register early handler for /api/context/inject to avoid 404 during startup
    // WHY: This endpoint is called immediately by hooks; must not 404 while SearchRoutes initializes
    this.server.app.get('/api/context/inject', async (req, res, next) => {
      // WHAT: Set 5 minute timeout for initialization wait
      // WHY: Slow systems (especially Windows with antivirus) may take a long time to initialize
      //      REASON: 5 minutes seems excessive but matches MCP init timeout for consistency
      const timeoutMs = 300000;

      // WHAT: Create timeout promise that rejects after timeoutMs
      // WHY: Prevents indefinite waiting if initialization hangs
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
      );

      // WHAT: Race between initialization completion and timeout
      // WHY: Either initialization finishes or we timeout with error
      await Promise.race([this.initializationComplete, timeoutPromise]);

      // WHAT: Check if search routes initialized successfully
      // WHY: SearchRoutes could fail to initialize even if other init succeeded
      if (!this.searchRoutes) {
        res.status(503).json({ error: 'Search routes not initialized' });
        return;
      }

      // WHAT: Call next() to delegate to actual SearchRoutes handler
      // WHY: This middleware just ensures initialization; actual logic is in SearchRoutes
      next();
    });
  }

  /**
   * WHAT: Starts the worker service - main entry point
   * WHY: Called by CLI when running as daemon; starts HTTP server and background init
   */
  async start(): Promise<void> {
    // WHAT: Get configured port (default 37777)
    // WHY: Port is configurable via environment variable
    const port = getWorkerPort();

    // WHAT: Get configured host (default localhost)
    // WHY: Host is configurable for network access scenarios
    const host = getWorkerHost();

    // WHAT: Start HTTP server FIRST before background initialization
    // WHY: Makes port available immediately; hooks can connect while DB initializes
    await this.server.listen(port, host);
    logger.info('SYSTEM', 'Worker started', { host, port, pid: process.pid });

    // WHAT: Run slow initialization in background (non-blocking)
    // WHY: Database init, MCP connection can take seconds; don't block HTTP server
    this.initializeBackground().catch((error) => {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
    });
  }

  /**
   * WHAT: Background initialization that runs after HTTP server is listening
   * WHY: Slow operations (DB init, MCP connection) run async to not block server start
   */
  private async initializeBackground(): Promise<void> {
    try {
      // WHAT: Clean up any orphaned worker processes from previous crashes
      // WHY: Prevents port conflicts and zombie processes
      await cleanupOrphanedProcesses();

      // WHAT: Dynamic import of ModeManager for mode configuration
      // WHY: Lazy load to reduce initial startup time
      const { ModeManager } = await import('./domain/ModeManager.js');

      // WHAT: Dynamic import of SettingsDefaultsManager for settings loading
      // WHY: Lazy load to reduce initial startup time
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');

      // WHAT: Dynamic import of USER_SETTINGS_PATH constant
      // WHY: Lazy load to reduce initial startup time
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      // WHAT: Load settings from file using defaults manager
      // WHY: Settings file may not exist; defaults manager handles that case
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

      // WHAT: Get mode ID from settings (default or custom mode)
      // WHY: Mode determines behavior profiles (e.g., minimal, full, custom)
      const modeId = settings.CLAUDE_MEM_MODE;

      // WHAT: Load the configured mode into ModeManager singleton
      // WHY: Mode affects observation processing and context injection behavior
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      // WHAT: Initialize database connection and run migrations
      // WHY: SQLite database must be open before any data operations
      await this.dbManager.initialize();

      // WHAT: Dynamic import of PendingMessageStore for queue recovery
      // WHY: Lazy load because only needed for startup recovery
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');

      // WHAT: Create pending message store with max 3 retries
      // WHY: Pending messages are observations waiting for AI processing
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

      // WHAT: Define threshold for "stuck" messages (5 minutes)
      // WHY: Messages processing longer than this are likely from crashed sessions
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

      // WHAT: Reset stuck messages to pending status
      // WHY: Crashed workers leave messages in "processing" state; must recover them
      const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
      if (resetCount > 0) {
        logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`, { thresholdMinutes: 5 });
      }

      // WHAT: Initialize search services (formatting, timeline, search manager)
      // WHY: Search functionality requires these services
      const formattingService = new FormattingService();
      const timelineService = new TimelineService();

      // WHAT: Create search manager with all required dependencies
      // WHY: SearchManager orchestrates full-text and semantic search operations
      const searchManager = new SearchManager(
        this.dbManager.getSessionSearch(),
        this.dbManager.getSessionStore(),
        this.dbManager.getChromaSync(),
        formattingService,
        timelineService
      );

      // WHAT: Create and register search routes
      // WHY: Search endpoints now available after manager initialized
      this.searchRoutes = new SearchRoutes(searchManager);
      this.server.registerRoutes(this.searchRoutes);
      logger.info('WORKER', 'SearchManager initialized and search routes registered');

      // WHAT: Resolve path to MCP server script
      // WHY: MCP server runs as subprocess; need absolute path to script
      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');

      // WHAT: Create stdio transport for MCP communication
      // WHY: MCP protocol uses JSON-RPC over stdin/stdout with subprocess
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env: process.env
      });

      // WHAT: Set MCP initialization timeout to 5 minutes
      // WHY: MCP server startup can be slow on some systems; match other timeouts
      const MCP_INIT_TIMEOUT_MS = 300000;

      // WHAT: Create promise for MCP connection
      // WHY: Need to race against timeout
      const mcpConnectionPromise = this.mcpClient.connect(transport);

      // WHAT: Create timeout promise that rejects after 5 minutes
      // WHY: Prevents indefinite hang if MCP server fails to start
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
      );

      // WHAT: Race MCP connection against timeout
      // WHY: Either connection succeeds or we fail with timeout error
      await Promise.race([mcpConnectionPromise, timeoutPromise]);

      // WHAT: Set MCP ready flag on successful connection
      // WHY: Endpoints can check this flag before using MCP functionality
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      // WHAT: Set initialization complete flag and resolve promise
      // WHY: Signals to waiting endpoints that full initialization is done
      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Background initialization complete');

      // WHAT: Auto-recover orphaned session queues (fire-and-forget)
      // WHY: Previous crashes may have left sessions with pending work
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
   * WHAT: Starts an AI processing session for a session's observation queue
   * WHY: Each session needs a generator loop processing its queued observations
   *
   * @param session - The session to start processing for
   * @param source - Description of why processor is starting (for logging)
   */
  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string
  ): void {
    // WHAT: Early return if session is null/undefined
    // WHY: Session could be deleted between queue check and processor start
    if (!session) return;

    // WHAT: Extract session database ID for logging
    // WHY: Log messages need session identifier
    const sid = session.sessionDbId;
    logger.info('SYSTEM', `Starting generator (${source})`, { sessionId: sid });

    // WHAT: Start SDK agent session and store promise on session object
    // WHY: Promise allows checking if generator is still running
    session.generatorPromise = this.sdkAgent.startSession(session, this)
      .catch(error => {
        // WHAT: Log generator errors but don't crash
        // WHY: One session's failure shouldn't affect others
        logger.error('SDK', 'Session generator failed', {
          sessionId: session.sessionDbId,
          project: session.project
        }, error as Error);
      })
      .finally(() => {
        // WHAT: Clear generator promise and broadcast status on completion
        // WHY: Session is no longer processing; UI needs updated status
        session.generatorPromise = null;
        this.broadcastProcessingStatus();
      });
  }

  /**
   * WHAT: Processes pending session queues to recover orphaned work
   * WHY: Worker crashes leave sessions with unprocessed observations; this recovers them
   *
   * @param sessionLimit - Maximum number of sessions to start processing (default 10)
   * @returns Summary of recovery operation
   */
  async processPendingQueues(sessionLimit: number = 10): Promise<{
    totalPendingSessions: number;
    sessionsStarted: number;
    sessionsSkipped: number;
    startedSessionIds: number[];
  }> {
    // WHAT: Dynamic import of PendingMessageStore
    // WHY: Lazy load because method may not be called often
    const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');

    // WHAT: Create pending store instance with max 3 retries
    // WHY: Need to query for sessions with pending messages
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

    // WHAT: Get list of session IDs that have pending messages
    // WHY: These are orphaned sessions needing recovery
    const orphanedSessionIds = pendingStore.getSessionsWithPendingMessages();

    // WHAT: Initialize result tracking object
    // WHY: Caller needs to know what was processed
    const result = {
      totalPendingSessions: orphanedSessionIds.length,
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[]
    };

    // WHAT: Early return if no orphaned sessions
    // WHY: Nothing to do if no pending work
    if (orphanedSessionIds.length === 0) return result;

    logger.info('SYSTEM', `Processing up to ${sessionLimit} of ${orphanedSessionIds.length} pending session queues`);

    // WHAT: Iterate through orphaned sessions up to limit
    // WHY: Process sessions one at a time with rate limiting
    for (const sessionDbId of orphanedSessionIds) {
      // WHAT: Check if we've hit the session limit
      // WHY: Don't overload the system by recovering too many at once
      if (result.sessionsStarted >= sessionLimit) break;

      try {
        // WHAT: Check if session already has an active generator
        // WHY: Don't start duplicate processors for same session
        const existingSession = this.sessionManager.getSession(sessionDbId);
        if (existingSession?.generatorPromise) {
          result.sessionsSkipped++;
          continue;
        }

        // WHAT: Initialize session object from database
        // WHY: Need session state before starting processor
        const session = this.sessionManager.initializeSession(sessionDbId);
        logger.info('SYSTEM', `Starting processor for session ${sessionDbId}`, {
          project: session.project,
          pendingCount: pendingStore.getPendingCount(sessionDbId)
        });

        // WHAT: Start the session processor
        // WHY: Begin processing the session's pending observations
        this.startSessionProcessor(session, 'startup-recovery');
        result.sessionsStarted++;
        result.startedSessionIds.push(sessionDbId);

        // WHAT: Small delay between starting sessions
        // WHY: Prevents thundering herd if many sessions need recovery
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // WHAT: Log error and skip session on failure
        // WHY: One session's failure shouldn't stop recovery of others
        logger.error('SYSTEM', `Failed to process session ${sessionDbId}`, {}, error as Error);
        result.sessionsSkipped++;
      }
    }

    return result;
  }

  /**
   * WHAT: Gracefully shuts down the worker service
   * WHY: Clean shutdown ensures database is flushed, connections closed properly
   */
  async shutdown(): Promise<void> {
    // WHAT: Delegate to graceful shutdown orchestrator
    // WHY: Shutdown logic is complex; centralized in GracefulShutdown module
    await performGracefulShutdown({
      server: this.server.getHttpServer(),
      sessionManager: this.sessionManager,
      mcpClient: this.mcpClient,
      dbManager: this.dbManager
    });
  }

  /**
   * WHAT: Broadcasts processing status update to all SSE clients
   * WHY: Viewer UI shows processing indicator; needs real-time updates
   */
  broadcastProcessingStatus(): void {
    // WHAT: Check if any session is currently processing observations
    // WHY: UI shows "processing" spinner when true
    const isProcessing = this.sessionManager.isAnySessionProcessing();

    // WHAT: Get total count of pending observations across all sessions
    // WHY: UI shows queue depth indicator
    const queueDepth = this.sessionManager.getTotalActiveWork();

    // WHAT: Get count of active sessions
    // WHY: Useful metric for status display
    const activeSessions = this.sessionManager.getActiveSessionCount();

    logger.info('WORKER', 'Broadcasting processing status', {
      isProcessing,
      queueDepth,
      activeSessions
    });

    // WHAT: Send SSE event to all connected clients
    // WHY: Real-time update without polling
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
  }
}

// ============================================================================
// Interactive Setup Wizard
// ============================================================================

/**
 * WHAT: Interactive CLI wizard for setting up claude-mem with Cursor IDE
 * WHY: Guides users through provider selection and hook installation
 *
 * @returns Exit code (0 for success, 1 for failure)
 */
async function runInteractiveSetup(): Promise<number> {
  // WHAT: Create readline interface for interactive prompts
  // WHY: Wizard needs to prompt user for choices via stdin/stdout
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // WHAT: Promisified question helper function
  // WHY: Converts callback-based rl.question to async/await
  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => rl.question(prompt, resolve));
  };

  // WHAT: Display welcome banner
  // WHY: Sets context for what the wizard will do
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           Claude-Mem Cursor Setup Wizard                         ║
║                                                                  ║
║  This wizard will guide you through setting up claude-mem        ║
║  for use with Cursor IDE.                                        ║
╚══════════════════════════════════════════════════════════════════╝
`);

  try {
    // WHAT: Step 1 - Check environment
    // WHY: Need to know if Claude Code is available for provider recommendations
    console.log('Step 1: Checking environment...\n');

    // WHAT: Detect if Claude Code CLI is installed
    // WHY: Claude SDK provider requires Claude Code subscription
    const hasClaudeCode = await detectClaudeCode();

    // WHAT: Determine settings file path
    // WHY: Settings stored in ~/.claude-mem/settings.json
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');

    // WHAT: Initialize empty settings object
    // WHY: Will be populated from file or remain empty for new users
    let settings: Record<string, unknown> = {};

    // WHAT: Load existing settings if file exists
    // WHY: Preserve user's previous configuration choices
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch (error) {
        // WHAT: Log but continue if settings file is corrupt
        // WHY: Better to start fresh than fail setup
        logger.debug('SETUP', 'Corrupt settings file, starting fresh', { path: settingsPath }, error as Error);
      }
    }

    // WHAT: Determine current provider (default to claude-sdk if Claude Code available)
    // WHY: Show user what's currently configured
    const currentProvider = settings['CLAUDE_MEM_PROVIDER'] as string || (hasClaudeCode ? 'claude-sdk' : 'none');

    // WHAT: Display detection results
    // WHY: Inform user of environment state
    if (hasClaudeCode) {
      console.log('Claude Code detected\n');
    } else {
      console.log('Claude Code not detected\n');
    }

    console.log(`Current provider: ${currentProvider}\n`);

    // WHAT: Step 2 - Provider selection
    // WHY: User chooses which AI backend to use for observation compression
    console.log('Step 2: Choose AI Provider\n');
    if (hasClaudeCode) {
      console.log('  [1] Claude SDK (Recommended - uses your Claude Code subscription)');
    } else {
      console.log('  [1] Claude SDK (requires Claude Code subscription)');
    }
    console.log('  [2] Gemini (1500 free requests/day)');
    console.log('  [3] OpenRouter (100+ models, some free)');
    console.log('  [4] Keep current settings\n');

    // WHAT: Get user's provider choice
    // WHY: Need to configure the selected provider
    const providerChoice = await question('Enter choice [1-4]: ');

    // WHAT: Handle Claude SDK selection
    // WHY: Just sets provider name; no API key needed (uses Claude Code auth)
    if (providerChoice === '1') {
      settings['CLAUDE_MEM_PROVIDER'] = 'claude-sdk';
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('\nClaude SDK configured!\n');
    }
    // WHAT: Handle Gemini selection
    // WHY: Needs API key from Google AI Studio
    else if (providerChoice === '2') {
      console.log('\nConfiguring Gemini...\n');
      console.log('   Get your free API key at: https://aistudio.google.com/apikey\n');

      const apiKey = await question('Enter your Gemini API key: ');
      if (apiKey.trim()) {
        settings['CLAUDE_MEM_PROVIDER'] = 'gemini';
        settings['CLAUDE_MEM_GEMINI_API_KEY'] = apiKey.trim();
        mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('\nGemini configured successfully!\n');
      } else {
        console.log('\nNo API key provided. You can add it later in ~/.claude-mem/settings.json\n');
      }
    }
    // WHAT: Handle OpenRouter selection
    // WHY: Needs API key from OpenRouter
    else if (providerChoice === '3') {
      console.log('\nConfiguring OpenRouter...\n');
      console.log('   Get your API key at: https://openrouter.ai/keys\n');

      const apiKey = await question('Enter your OpenRouter API key: ');
      if (apiKey.trim()) {
        settings['CLAUDE_MEM_PROVIDER'] = 'openrouter';
        settings['CLAUDE_MEM_OPENROUTER_API_KEY'] = apiKey.trim();
        mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('\nOpenRouter configured successfully!\n');
      } else {
        console.log('\nNo API key provided. You can add it later in ~/.claude-mem/settings.json\n');
      }
    }
    // WHAT: Handle "keep current" selection
    // WHY: User may just want to reinstall hooks without changing provider
    else {
      console.log('\nKeeping current settings.\n');
    }

    // WHAT: Step 3 - Installation scope selection
    // WHY: Hooks can be installed per-project or per-user
    console.log('Step 3: Choose installation scope\n');
    console.log('  [1] Project (current directory only) - Recommended');
    console.log('  [2] User (all projects for current user)');
    console.log('  [3] Skip hook installation\n');

    // WHAT: Get user's scope choice
    // WHY: Determines where hooks are installed
    const scopeChoice = await question('Enter choice [1-3]: ');

    // WHAT: Map choice to install target
    // WHY: installCursorHooks expects 'project' or 'user'
    let installTarget: string | null = null;
    if (scopeChoice === '1') {
      installTarget = 'project';
    } else if (scopeChoice === '2') {
      installTarget = 'user';
    } else {
      console.log('\nSkipping hook installation.\n');
    }

    // WHAT: Install hooks if target selected
    // WHY: Only install if user didn't skip
    if (installTarget) {
      console.log(`Step 4: Installing Cursor hooks (${installTarget})...\n`);

      // WHAT: Find cursor-hooks build directory
      // WHY: Need path to built hook scripts
      const cursorHooksDir = findCursorHooksDir();
      if (!cursorHooksDir) {
        console.error('Could not find cursor-hooks directory');
        console.error('   Make sure you ran npm run build first.');
        rl.close();
        return 1;
      }

      // WHAT: Install hooks to selected scope
      // WHY: Copies hook scripts to Cursor config directory
      const installResult = await installCursorHooks(cursorHooksDir, installTarget as 'project' | 'user');
      if (installResult !== 0) {
        rl.close();
        return installResult;
      }

      // WHAT: Step 5 - Configure MCP server
      // WHY: MCP enables memory search functionality in Cursor
      console.log('\nStep 5: Configuring MCP server for memory search...\n');
      const mcpResult = configureCursorMcp(installTarget as 'project' | 'user');
      if (mcpResult !== 0) {
        // WHAT: Warn but continue if MCP config fails
        // WHY: Hooks are more important; MCP can be configured manually
        console.warn('MCP configuration failed, but hooks are installed.');
        console.warn('   You can manually configure MCP later.\n');
      } else {
        console.log('');
      }
    }

    // WHAT: Step 6 - Start worker
    // WHY: Worker must be running for hooks to communicate with
    console.log('\nStep 6: Starting claude-mem worker...\n');

    // WHAT: Get worker port
    // WHY: Need port for health check
    const port = getWorkerPort();

    // WHAT: Check if worker already running
    // WHY: Don't start duplicate worker
    const alreadyRunning = await waitForHealth(port, 1000);

    if (alreadyRunning) {
      console.log('Worker is already running!\n');
    } else {
      console.log('   Starting worker in background...');

      // WHAT: Spawn worker daemon
      // WHY: Worker runs as detached background process
      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        console.error('Failed to start worker');
        rl.close();
        return 1;
      }

      // WHAT: Write PID file with process info
      // WHY: Enables stop/restart commands to find the worker
      writePidFile({ pid, port, startedAt: new Date().toISOString() });

      // WHAT: Wait for worker to become healthy
      // WHY: Ensure worker started successfully before declaring success
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        console.error('Worker failed to start');
        rl.close();
        return 1;
      }

      console.log('Worker started successfully!\n');
    }

    // WHAT: Display completion message with next steps
    // WHY: Guide user on what to do after setup
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Setup Complete!                               ║
╚══════════════════════════════════════════════════════════════════╝

What's installed:
  - Cursor hooks - Automatically capture sessions
  - Context injection - Past work injected into new chats
  - MCP search server - Ask "what did I work on last week?"

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

    // WHAT: Close readline interface
    // WHY: Release stdin/stdout resources
    rl.close();
    return 0;
  } catch (error) {
    // WHAT: Handle setup errors
    // WHY: Display error and exit with failure code
    rl.close();
    console.error(`\nSetup failed: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * WHAT: Main CLI entry point - parses commands and dispatches to handlers
 * WHY: Worker service supports multiple commands (start, stop, status, etc.)
 */
async function main() {
  // WHAT: Get command from argv[2]
  // WHY: First two args are node and script path; command is third
  const command = process.argv[2];

  // WHAT: Get worker port for all commands
  // WHY: Most commands need to communicate with worker
  const port = getWorkerPort();

  /**
   * WHAT: Helper function to exit with JSON status output
   * WHY: Hook framework expects structured JSON; exit code 0 prevents Windows Terminal tab accumulation
   *
   * @param status - 'ready' or 'error'
   * @param message - Optional error message
   */
  function exitWithStatus(status: 'ready' | 'error', message?: string): never {
    const output = buildStatusOutput(status, message);
    console.log(JSON.stringify(output));
    // WHAT: Always exit with code 0
    // WHY: Windows Terminal keeps tabs open on non-zero exit; hook framework reads status from JSON
    process.exit(0);
  }

  // WHAT: Command dispatch switch statement
  // WHY: Routes CLI command to appropriate handler
  switch (command) {
    // ========================================================================
    // START command - Start worker daemon
    // ========================================================================
    case 'start': {
      // WHAT: Check if worker already running and healthy
      // WHY: Don't start duplicate workers
      if (await waitForHealth(port, 1000)) {
        // WHAT: Check if running worker matches plugin version
        // WHY: Auto-restart on version mismatch to pick up updates
        const versionCheck = await checkVersionMatch(port);
        if (!versionCheck.matches) {
          logger.info('SYSTEM', 'Worker version mismatch detected - auto-restarting', {
            pluginVersion: versionCheck.pluginVersion,
            workerVersion: versionCheck.workerVersion
          });

          // WHAT: Shutdown old worker via HTTP
          // WHY: Need to stop before starting new version
          await httpShutdown(port);

          // WHAT: Wait for port to become free
          // WHY: Can't start new worker while port is in use
          const freed = await waitForPortFree(port, getPlatformTimeout(15000));
          if (!freed) {
            logger.error('SYSTEM', 'Port did not free up after shutdown for version mismatch restart', { port });
            exitWithStatus('error', 'Port did not free after version mismatch restart');
          }

          // WHAT: Remove stale PID file
          // WHY: Old PID is invalid after shutdown
          removePidFile();
        } else {
          // WHAT: Worker running and version matches
          // WHY: Nothing to do; report success
          logger.info('SYSTEM', 'Worker already running and healthy');
          exitWithStatus('ready');
        }
      }

      // WHAT: Check if port is in use (but not by healthy worker)
      // WHY: Could be worker starting up or zombie process
      const portInUse = await isPortInUse(port);
      if (portInUse) {
        logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');

        // WHAT: Wait for worker to become healthy
        // WHY: Port might be in use by worker that's still initializing
        const healthy = await waitForHealth(port, getPlatformTimeout(15000));
        if (healthy) {
          logger.info('SYSTEM', 'Worker is now healthy');
          exitWithStatus('ready');
        }

        // WHAT: Port in use but no healthy worker
        // WHY: Likely zombie process; report error
        logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
        exitWithStatus('error', 'Port in use but worker not responding');
      }

      // WHAT: Spawn worker daemon process
      // WHY: Worker needs to run in background, detached from CLI
      logger.info('SYSTEM', 'Starting worker daemon');
      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        exitWithStatus('error', 'Failed to spawn worker daemon');
      }

      // WHAT: Write PID file with process info
      // WHY: Stop/restart commands need to find the worker
      writePidFile({ pid, port, startedAt: new Date().toISOString() });

      // WHAT: Wait for worker to become healthy
      // WHY: Confirm worker started successfully before reporting success
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
        exitWithStatus('error', 'Worker failed to start (health check timeout)');
      }

      logger.info('SYSTEM', 'Worker started successfully');
      exitWithStatus('ready');
    }

    // ========================================================================
    // STOP command - Stop running worker
    // ========================================================================
    case 'stop': {
      // WHAT: Send shutdown request via HTTP
      // WHY: Graceful shutdown closes connections and flushes data
      await httpShutdown(port);

      // WHAT: Wait for port to become free
      // WHY: Confirm worker actually stopped
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
      }

      // WHAT: Remove PID file
      // WHY: Worker is stopped; PID is no longer valid
      removePidFile();
      logger.info('SYSTEM', 'Worker stopped successfully');
      process.exit(0);
    }

    // ========================================================================
    // RESTART command - Stop then start worker
    // ========================================================================
    case 'restart': {
      logger.info('SYSTEM', 'Restarting worker');

      // WHAT: Shutdown existing worker
      // WHY: Need to stop before restarting
      await httpShutdown(port);

      // WHAT: Wait for port to become free
      // WHY: Can't start new worker while port in use
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
        // WHAT: Exit with code 0 even on failure
        // WHY: Windows Terminal won't keep tab open on exit 0; wrapper handles restart logic
        process.exit(0);
      }

      // WHAT: Remove stale PID file
      // WHY: Old PID is invalid after shutdown
      removePidFile();

      // WHAT: Spawn new worker daemon
      // WHY: Start fresh worker process
      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
        // WHAT: Exit with code 0 even on failure
        // WHY: Windows Terminal won't keep tab open on exit 0; wrapper handles restart logic
        process.exit(0);
      }

      // WHAT: Write new PID file
      // WHY: Track new worker process
      writePidFile({ pid, port, startedAt: new Date().toISOString() });

      // WHAT: Wait for worker to become healthy
      // WHY: Confirm restart succeeded
      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to restart');
        // WHAT: Exit with code 0 even on failure
        // WHY: Windows Terminal won't keep tab open on exit 0; wrapper handles restart logic
        process.exit(0);
      }

      logger.info('SYSTEM', 'Worker restarted successfully');
      process.exit(0);
    }

    // ========================================================================
    // STATUS command - Show worker status
    // ========================================================================
    case 'status': {
      // WHAT: Check if port is in use
      // WHY: Indicates whether worker is running
      const running = await isPortInUse(port);

      // WHAT: Read PID file for process details
      // WHY: Display PID, port, and start time
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

    // ========================================================================
    // GENERATE command - Generate CLAUDE.md context
    // ========================================================================
    case 'generate': {
      // WHAT: Check for --dry-run flag
      // WHY: Dry run shows what would be generated without writing
      const dryRun = process.argv.includes('--dry-run');

      // WHAT: Dynamic import of claude-md-commands module
      // WHY: Lazy load because only needed for this command
      const { generateClaudeMd } = await import('../cli/claude-md-commands.js');

      // WHAT: Run generation and exit with result code
      // WHY: Returns 0 on success, 1 on failure
      const result = await generateClaudeMd(dryRun);
      process.exit(result);
    }

    // ========================================================================
    // CLEAN command - Remove CLAUDE.md context sections
    // ========================================================================
    case 'clean': {
      // WHAT: Check for --dry-run flag
      // WHY: Dry run shows what would be cleaned without modifying
      const dryRun = process.argv.includes('--dry-run');

      // WHAT: Dynamic import of claude-md-commands module
      // WHY: Lazy load because only needed for this command
      const { cleanClaudeMd } = await import('../cli/claude-md-commands.js');

      // WHAT: Run cleaning and exit with result code
      // WHY: Returns 0 on success, 1 on failure
      const result = await cleanClaudeMd(dryRun);
      process.exit(result);
    }

    // ========================================================================
    // CURSOR command - Cursor IDE integration commands
    // ========================================================================
    case 'cursor': {
      // WHAT: Get subcommand (setup, status, etc.)
      // WHY: Cursor has multiple subcommands
      const subcommand = process.argv[3];

      // WHAT: Handle cursor subcommand
      // WHY: Delegates to CursorHooksInstaller for implementation
      const cursorResult = await handleCursorCommand(subcommand, process.argv.slice(4));
      process.exit(cursorResult);
    }

    // ========================================================================
    // HOOK command - Direct hook invocation for testing
    // ========================================================================
    case 'hook': {
      // WHAT: Get platform and event from args
      // WHY: Hook command requires both parameters
      const platform = process.argv[3];
      const event = process.argv[4];

      if (!platform || !event) {
        console.error('Usage: claude-mem hook <platform> <event>');
        console.error('Platforms: claude-code, cursor, raw');
        console.error('Events: context, session-init, observation, summarize, user-message');
        process.exit(1);
      }

      // WHAT: Dynamic import of hook command handler
      // WHY: Lazy load because only needed for this command
      const { hookCommand } = await import('../cli/hook-command.js');

      // WHAT: Execute hook command
      // WHY: Simulates hook execution for testing
      await hookCommand(platform, event);
      break;
    }

    // ========================================================================
    // DEFAULT / --daemon - Run as daemon process
    // ========================================================================
    case '--daemon':
    default: {
      // WHAT: Create and start worker service instance
      // WHY: Default behavior is to run as daemon (called by spawnDaemon)
      const worker = new WorkerService();
      worker.start().catch((error) => {
        logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
        removePidFile();
        // WHAT: Exit with code 0 even on failure
        // WHY: Windows Terminal won't keep tab open on exit 0; wrapper handles restart logic
        process.exit(0);
      });
    }
  }
}

// ============================================================================
// Main Module Detection and Execution
// ============================================================================

// WHAT: Check if this file is being run as the main module
// WHY: Prevents main() from running when file is imported as a module
// NOTE: Works with both ESM and CommonJS module systems
const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  // WHAT: CommonJS check - require.main === module indicates main module
  // WHY: Node.js CommonJS convention for main module detection
  ? require.main === module || !module.parent
  // WHAT: ESM check - compare import.meta.url with process.argv[1]
  // WHY: ESM doesn't have require.main; use URL comparison instead
  : import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-service');

// WHAT: Run main() if this is the entry point
// WHY: Bootstrap the CLI when run directly
if (isMainModule) {
  main();
}
