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
import * as fs from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import * as readline from 'readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

// Infrastructure imports
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  cleanupOrphanedProcesses,
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

// Integration imports
import {
  updateCursorContextForProject,
  handleCursorCommand,
  detectClaudeCode,
  findCursorHooksDir,
  installCursorHooks,
  configureCursorMcp
} from './integrations/CursorHooksInstaller.js';

// Service layer imports
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

// HTTP route handlers
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';

// Re-export updateCursorContextForProject for SDK agents
export { updateCursorContextForProject };

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

  // Initialization tracking
  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

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
    this.geminiAgent.setFallbackAgent(this.sdkAgent);
    this.openRouterAgent = new OpenRouterAgent(this.dbManager, this.sessionManager);
    this.openRouterAgent.setFallbackAgent(this.sdkAgent);
    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);

    // Set callback for when sessions are deleted
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // Initialize MCP client
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: '1.0.0'
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
      handler('SIGTERM');
    });
    process.on('SIGINT', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGINT');
    });
  }

  /**
   * Register all route handlers with the server
   */
  private registerRoutes(): void {
    // Standard routes
    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));
    this.server.registerRoutes(new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.sessionEventBroadcaster, this));
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));
    this.server.registerRoutes(new LogsRoutes());

    // Early handler for /api/context/inject to avoid 404 during startup
    this.server.app.get('/api/context/inject', async (req, res, next) => {
      const timeoutMs = 300000; // 5 minute timeout for slow systems
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
      );

      await Promise.race([this.initializationComplete, timeoutPromise]);

      if (!this.searchRoutes) {
        res.status(503).json({ error: 'Search routes not initialized' });
        return;
      }

      next(); // Delegate to SearchRoutes handler
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
      await cleanupOrphanedProcesses();

      // Load mode configuration
      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const modeId = settings.CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      await this.dbManager.initialize();

      // Recover stuck messages from previous crashes
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
      const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
      if (resetCount > 0) {
        logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`, { thresholdMinutes: 5 });
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
        logger.warn('SYSTEM', 'Auto-recovery of pending queues failed', {}, error as Error);
      });
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      throw error;
    }
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
    logger.info('SYSTEM', `Starting generator (${source})`, { sessionId: sid });

    session.generatorPromise = this.sdkAgent.startSession(session, this)
      .catch(error => {
        logger.error('SDK', 'Session generator failed', {
          sessionId: session.sessionDbId,
          project: session.project
        }, error as Error);
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

    logger.info('SYSTEM', `Processing up to ${sessionLimit} of ${orphanedSessionIds.length} pending session queues`);

    for (const sessionDbId of orphanedSessionIds) {
      if (result.sessionsStarted >= sessionLimit) break;

      try {
        const existingSession = this.sessionManager.getSession(sessionDbId);
        if (existingSession?.generatorPromise) {
          result.sessionsSkipped++;
          continue;
        }

        const session = this.sessionManager.initializeSession(sessionDbId);
        logger.info('SYSTEM', `Starting processor for session ${sessionDbId}`, {
          project: session.project,
          pendingCount: pendingStore.getPendingCount(sessionDbId)
        });

        this.startSessionProcessor(session, 'startup-recovery');
        result.sessionsStarted++;
        result.startedSessionIds.push(sessionDbId);

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.warn('SYSTEM', `Failed to process session ${sessionDbId}`, {}, error as Error);
        result.sessionsSkipped++;
      }
    }

    return result;
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
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
// Interactive Setup Wizard
// ============================================================================

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
    console.log('Step 1: Checking environment...\n');

    const hasClaudeCode = await detectClaudeCode();
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    let settings: Record<string, unknown> = {};

    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch (error) {
        logger.debug('SETUP', 'Corrupt settings file, starting fresh', { path: settingsPath }, error as Error);
      }
    }

    const currentProvider = settings['CLAUDE_MEM_PROVIDER'] as string || (hasClaudeCode ? 'claude-sdk' : 'none');

    if (hasClaudeCode) {
      console.log('Claude Code detected\n');
    } else {
      console.log('Claude Code not detected\n');
    }

    console.log(`Current provider: ${currentProvider}\n`);

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
      console.log('\nClaude SDK configured!\n');
    } else if (providerChoice === '2') {
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
    } else if (providerChoice === '3') {
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
    } else {
      console.log('\nKeeping current settings.\n');
    }

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
      console.log('\nSkipping hook installation.\n');
    }

    if (installTarget) {
      console.log(`Step 4: Installing Cursor hooks (${installTarget})...\n`);

      const cursorHooksDir = findCursorHooksDir();
      if (!cursorHooksDir) {
        console.error('Could not find cursor-hooks directory');
        console.error('   Make sure you ran npm run build first.');
        rl.close();
        return 1;
      }

      const installResult = await installCursorHooks(cursorHooksDir, installTarget as 'project' | 'user');
      if (installResult !== 0) {
        rl.close();
        return installResult;
      }

      console.log('\nStep 5: Configuring MCP server for memory search...\n');
      const mcpResult = configureCursorMcp(installTarget as 'project' | 'user');
      if (mcpResult !== 0) {
        console.warn('MCP configuration failed, but hooks are installed.');
        console.warn('   You can manually configure MCP later.\n');
      } else {
        console.log('');
      }
    }

    console.log('\nStep 6: Starting claude-mem worker...\n');

    const port = getWorkerPort();
    const alreadyRunning = await waitForHealth(port, 1000);

    if (alreadyRunning) {
      console.log('Worker is already running!\n');
    } else {
      console.log('   Starting worker in background...');

      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        console.error('Failed to start worker');
        rl.close();
        return 1;
      }

      writePidFile({ pid, port, startedAt: new Date().toISOString() });

      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        console.error('Worker failed to start');
        rl.close();
        return 1;
      }

      console.log('Worker started successfully!\n');
    }

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

    rl.close();
    return 0;
  } catch (error) {
    rl.close();
    console.error(`\nSetup failed: ${(error as Error).message}`);
    return 1;
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
      if (await waitForHealth(port, 1000)) {
        const versionCheck = await checkVersionMatch(port);
        if (!versionCheck.matches) {
          logger.info('SYSTEM', 'Worker version mismatch detected - auto-restarting', {
            pluginVersion: versionCheck.pluginVersion,
            workerVersion: versionCheck.workerVersion
          });

          await httpShutdown(port);
          const freed = await waitForPortFree(port, getPlatformTimeout(15000));
          if (!freed) {
            logger.error('SYSTEM', 'Port did not free up after shutdown for version mismatch restart', { port });
            process.exit(1);
          }
          removePidFile();
        } else {
          logger.info('SYSTEM', 'Worker already running and healthy');
          process.exit(0);
        }
      }

      const portInUse = await isPortInUse(port);
      if (portInUse) {
        logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
        const healthy = await waitForHealth(port, getPlatformTimeout(15000));
        if (healthy) {
          logger.info('SYSTEM', 'Worker is now healthy');
          process.exit(0);
        }
        logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
        process.exit(1);
      }

      logger.info('SYSTEM', 'Starting worker daemon');
      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        process.exit(1);
      }

      writePidFile({ pid, port, startedAt: new Date().toISOString() });

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
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
      }
      removePidFile();
      logger.info('SYSTEM', 'Worker stopped successfully');
      process.exit(0);
    }

    case 'restart': {
      logger.info('SYSTEM', 'Restarting worker');
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
        process.exit(1);
      }
      removePidFile();

      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
        process.exit(1);
      }

      writePidFile({ pid, port, startedAt: new Date().toISOString() });

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
      const subcommand = process.argv[3];
      const cursorResult = await handleCursorCommand(subcommand, process.argv.slice(4));
      process.exit(cursorResult);
    }

    case '--daemon':
    default: {
      const worker = new WorkerService();
      worker.start().catch((error) => {
        logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
        removePidFile();
        process.exit(1);
      });
    }
  }
}

// Check if running as main module in both ESM and CommonJS
const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module || !module.parent
  : import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-service');

if (isMainModule) {
  main();
}
