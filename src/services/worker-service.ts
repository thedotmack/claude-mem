
import path from 'path';
import { existsSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { getAuthMethodDescription } from '../shared/EnvManager.js';
import { logger } from '../utils/logger.js';
import { ChromaMcpManager } from './sync/ChromaMcpManager.js';
import { ChromaSync } from './sync/ChromaSync.js';
import { configureSupervisorSignalHandlers, getSupervisor, startSupervisor } from '../supervisor/index.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';

import { ensureWorkerStarted as ensureWorkerStartedShared, type WorkerStartResult } from './worker-spawner.js';
import { handleGeneratorExit } from './worker/session/GeneratorExitHandler.js';

export { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  runOneTimeChromaMigration,
  runOneTimeCwdRemap,
  cleanStalePidFile,
  verifyPidFileOwnership,
  spawnDaemon,
  touchPidFile
} from './infrastructure/ProcessManager.js';
import { runOneTimeV12_4_3Cleanup } from './infrastructure/CleanupV12_4_3.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
  waitForPortFree,
  httpShutdown
} from './infrastructure/HealthMonitor.js';
import { performGracefulShutdown } from './infrastructure/GracefulShutdown.js';
import { adoptMergedWorktrees, adoptMergedWorktreesForAllKnownRepos } from './infrastructure/WorktreeAdoption.js';

import { Server } from './server/Server.js';

import {
  updateCursorContextForProject,
  handleCursorCommand
} from './integrations/CursorHooksInstaller.js';
import {
  handleGeminiCliCommand
} from './integrations/GeminiCliHooksInstaller.js';

import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { ClaudeProvider, classifyClaudeError } from './worker/ClaudeProvider.js';
import type { WorkerRef } from './worker/agents/types.js';
import { GeminiProvider, classifyGeminiError, isGeminiSelected, isGeminiAvailable } from './worker/GeminiProvider.js';
import { OpenRouterProvider, classifyOpenRouterError, isOpenRouterSelected, isOpenRouterAvailable } from './worker/OpenRouterProvider.js';
import { ClassifiedProviderError, isClassified, type ProviderErrorClass } from './worker/provider-errors.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';
import { SearchManager } from './worker/SearchManager.js';
import { FormattingService } from './worker/FormattingService.js';
import { TimelineService } from './worker/TimelineService.js';
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';
import { SessionCompletionHandler } from './worker/session/SessionCompletionHandler.js';
import { setIngestContext, attachIngestGeneratorStarter } from './worker/http/shared.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, loadTranscriptWatchConfig, writeSampleConfig } from './transcripts/config.js';
import { TranscriptWatcher } from './transcripts/watcher.js';

import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';
import { MemoryRoutes } from './worker/http/routes/MemoryRoutes.js';
import { CorpusRoutes } from './worker/http/routes/CorpusRoutes.js';
import { ChromaRoutes } from './worker/http/routes/ChromaRoutes.js';

import { CorpusStore } from './worker/knowledge/CorpusStore.js';
import { CorpusBuilder } from './worker/knowledge/CorpusBuilder.js';
import { KnowledgeAgent } from './worker/knowledge/KnowledgeAgent.js';

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

export class WorkerService implements WorkerRef {
  private server: Server;
  private startTime: number = Date.now();
  private mcpClient: Client;

  private mcpReady: boolean = false;
  private initializationCompleteFlag: boolean = false;
  private isShuttingDown: boolean = false;

  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  public sseBroadcaster: SSEBroadcaster;
  private sdkAgent: ClaudeProvider;
  private geminiAgent: GeminiProvider;
  private openRouterAgent: OpenRouterProvider;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
  private sessionEventBroadcaster: SessionEventBroadcaster;
  private completionHandler: SessionCompletionHandler;
  private corpusStore: CorpusStore;

  private searchRoutes: SearchRoutes | null = null;

  private chromaMcpManager: ChromaMcpManager | null = null;

  private transcriptWatcher: TranscriptWatcher | null = null;

  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

  private lastAiInteraction: {
    timestamp: number;
    success: boolean;
    provider: string;
    error?: string;
  } | null = null;

  constructor() {
    this.initializationComplete = new Promise((resolve) => {
      this.resolveInitialization = resolve;
    });

    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new ClaudeProvider(this.dbManager, this.sessionManager);
    this.geminiAgent = new GeminiProvider(this.dbManager, this.sessionManager);
    this.openRouterAgent = new OpenRouterProvider(this.dbManager, this.sessionManager);

    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);
    this.completionHandler = new SessionCompletionHandler(
      this.sessionManager,
      this.sessionEventBroadcaster,
      this.dbManager,
    );
    this.corpusStore = new CorpusStore();

    setIngestContext({
      sessionManager: this.sessionManager,
      dbManager: this.dbManager,
      eventBroadcaster: this.sessionEventBroadcaster,
    });

    this.sessionManager.setOnPendingMutate(() => this.broadcastProcessingStatus());

    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: packageVersion
    }, { capabilities: {} });

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

    this.registerRoutes();

    this.registerSignalHandlers();
  }

  private registerSignalHandlers(): void {
    configureSupervisorSignalHandlers(async () => {
      this.isShuttingDown = true;
      await this.shutdown();
    });
  }

  private registerRoutes(): void {

    this.server.registerRoutes(new ChromaRoutes());

    this.server.app.get('/api/context/inject', async (req, res, next) => {
      if (!this.initializationCompleteFlag || !this.searchRoutes) {
        logger.warn('SYSTEM', 'Context requested before initialization complete, returning empty');
        res.status(200).json({ content: [{ type: 'text', text: '' }] });
        return;
      }

      next(); 
    });

    this.server.app.use('/api', async (req, res, next) => {
      if (req.path === '/chroma/status' || req.path === '/health' || req.path === '/readiness' || req.path === '/version') {
        next();
        return;
      }

      if (this.initializationCompleteFlag) {
        next();
        return;
      }

      const timeoutMs = 120000; 
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Database initialization timeout')), timeoutMs)
      );

      try {
        await Promise.race([this.initializationComplete, timeoutPromise]);
        next();
      } catch (error) {
        if (error instanceof Error) {
          logger.error('WORKER', `Request to ${req.method} ${req.path} rejected — DB not initialized`, {}, error);
        } else {
          logger.error('WORKER', `Request to ${req.method} ${req.path} rejected — DB not initialized with non-Error`, {}, new Error(String(error)));
        }
        res.status(503).json({
          error: 'Service initializing',
          message: 'Database is still initializing, please retry'
        });
        return;
      }
    });

    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));
    const sessionRoutes = new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openRouterAgent, this.sessionEventBroadcaster, this, this.completionHandler);
    this.server.registerRoutes(sessionRoutes);
    attachIngestGeneratorStarter((sessionDbId, source) =>
      sessionRoutes.ensureGeneratorRunning(sessionDbId, source),
    );
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));
    this.server.registerRoutes(new LogsRoutes());
    this.server.registerRoutes(new MemoryRoutes(this.dbManager, 'claude-mem'));
  }

  async start(): Promise<void> {
    const port = getWorkerPort();
    const host = getWorkerHost();

    await startSupervisor();

    await this.server.listen(port, host);

    writePidFile({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    getSupervisor().registerProcess('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: new Date().toISOString()
    });

    logger.info('SYSTEM', 'Worker started', { host, port, pid: process.pid });

    this.initializeBackground().catch((error) => {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
    });
  }

  private async initializeBackground(): Promise<void> {
    try {
      logger.info('WORKER', 'Background initialization starting...');

      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

      const modeId = settings.CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      if (settings.CLAUDE_MEM_MODE === 'local' || !settings.CLAUDE_MEM_MODE) {
        logger.info('WORKER', 'Checking for one-time Chroma migration...');
        runOneTimeChromaMigration();
      }

      logger.info('WORKER', 'Checking for one-time CWD remap...');
      runOneTimeCwdRemap();

      logger.info('WORKER', 'Adopting merged worktrees (background)...');
      adoptMergedWorktreesForAllKnownRepos({}).then(adoptions => {
        if (adoptions) {
          for (const adoption of adoptions) {
            if (adoption.adoptedObservations > 0 || adoption.adoptedSummaries > 0 || adoption.chromaUpdates > 0) {
              logger.info('SYSTEM', 'Merged worktrees adopted in background', adoption);
            }
            if (adoption.errors.length > 0) {
              logger.warn('SYSTEM', 'Worktree adoption had per-branch errors', {
                repoPath: adoption.repoPath,
                errors: adoption.errors
              });
            }
          }
        }
      }).catch(err => {
        logger.error('WORKER', 'Worktree adoption failed (background)', {}, err instanceof Error ? err : new Error(String(err)));
      });

      const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
      if (chromaEnabled) {
        this.chromaMcpManager = ChromaMcpManager.getInstance();
        logger.info('SYSTEM', 'ChromaMcpManager initialized (lazy - connects on first use)');
      } else {
        logger.info('SYSTEM', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, skipping ChromaMcpManager');
      }

      logger.info('WORKER', 'Initializing database manager...');
      await this.dbManager.initialize();

      const sweepResult = this.dbManager.getSessionStore().db.prepare(`
        UPDATE pending_messages
           SET status = 'pending'
         WHERE status = 'processing'
      `).run();

      if (sweepResult.changes > 0) {
        logger.info('SYSTEM', `Startup orphan sweep reclaimed ${sweepResult.changes} processing rows`);
      }

      runOneTimeV12_4_3Cleanup();

      logger.info('WORKER', 'Initializing search services...');
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

      const { SearchOrchestrator } = await import('./worker/search/SearchOrchestrator.js');
      const corpusSearchOrchestrator = new SearchOrchestrator(
        this.dbManager.getSessionSearch(),
        this.dbManager.getSessionStore(),
        this.dbManager.getChromaSync()
      );
      const corpusBuilder = new CorpusBuilder(
        this.dbManager.getSessionStore(),
        corpusSearchOrchestrator,
        this.corpusStore
      );
      const knowledgeAgent = new KnowledgeAgent(this.corpusStore);
      this.server.registerRoutes(new CorpusRoutes(this.corpusStore, corpusBuilder, knowledgeAgent));
      logger.info('WORKER', 'CorpusRoutes registered');

      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Core initialization complete (DB + search ready)');

      await this.startTranscriptWatcher(settings);

      if (this.chromaMcpManager) {
        ChromaSync.backfillAllProjects(this.dbManager.getSessionStore()).then(() => {
          logger.info('CHROMA_SYNC', 'Backfill check complete for all projects');
        }).catch(error => {
          logger.error('CHROMA_SYNC', 'Backfill failed (non-blocking)', {}, error as Error);
        });
      }

      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
      this.mcpReady = existsSync(mcpServerPath);

      this.runMcpSelfCheck(mcpServerPath).catch(err => {
        logger.debug('WORKER', 'MCP self-check failed (non-fatal)', { error: err.message });
      });

      return;
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error instanceof Error ? error : undefined);
    }
  }

  private async runMcpSelfCheck(mcpServerPath: string): Promise<void> {
    try {
      getSupervisor().assertCanSpawn('mcp server');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpServerPath],
        env: Object.fromEntries(
          Object.entries(sanitizeEnv(process.env)).filter(([, value]) => value !== undefined)
        ) as Record<string, string>
      });

      const MCP_INIT_TIMEOUT_MS = 60000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('MCP connection timeout')),
          MCP_INIT_TIMEOUT_MS
        );
      });

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      logger.info('WORKER', 'MCP loopback self-check connected successfully');

      await transport.close();
    } catch (error) {
      logger.warn('WORKER', 'MCP loopback self-check failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  private async startTranscriptWatcher(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): Promise<void> {
    const transcriptsEnabled = settings.CLAUDE_MEM_TRANSCRIPTS_ENABLED !== 'false';
    if (!transcriptsEnabled) {
      logger.info('TRANSCRIPT', 'Transcript watcher disabled via CLAUDE_MEM_TRANSCRIPTS_ENABLED=false');
      return;
    }

    const configPath = settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH || DEFAULT_CONFIG_PATH;
    const resolvedConfigPath = expandHomePath(configPath);

    if (!existsSync(resolvedConfigPath)) {
      writeSampleConfig(configPath);
      logger.info('TRANSCRIPT', 'Created default transcript watch config', {
        configPath: resolvedConfigPath
      });
    }

    const transcriptConfig = loadTranscriptWatchConfig(configPath);
    const statePath = expandHomePath(transcriptConfig.stateFile ?? DEFAULT_STATE_PATH);

    try {
      this.transcriptWatcher = new TranscriptWatcher(transcriptConfig, statePath);
      await this.transcriptWatcher.start();
    } catch (error) {
      this.transcriptWatcher?.stop();
      this.transcriptWatcher = null;
      if (error instanceof Error) {
        logger.error('WORKER', 'Failed to start transcript watcher (continuing without Codex ingestion)', {
          configPath: resolvedConfigPath
        }, error);
      } else {
        logger.error('WORKER', 'Failed to start transcript watcher with non-Error (continuing without Codex ingestion)', {
          configPath: resolvedConfigPath
        }, new Error(String(error)));
      }
      return;
    }
    logger.info('TRANSCRIPT', 'Transcript watcher started', {
      configPath: resolvedConfigPath,
      statePath,
      watches: transcriptConfig.watches.length
    });
  }

  private getActiveAgent(): ClaudeProvider | GeminiProvider | OpenRouterProvider {
    if (isOpenRouterSelected() && isOpenRouterAvailable()) {
      return this.openRouterAgent;
    }
    if (isGeminiSelected() && isGeminiAvailable()) {
      return this.geminiAgent;
    }
    return this.sdkAgent;
  }

  /**
   * Re-classify a raw error at the worker-service dispatch site using the
   * active provider's classifier. Returns null when the provider classifier
   * doesn't recognize the shape (caller falls back to default behavior).
   *
   * Most provider errors should already be classified at the provider
   * boundary — this is a safety net for errors from inside the SDK that
   * never round-tripped through fetch (e.g. Anthropic SDK exceptions).
   */
  private reclassifyAtDispatch(
    error: unknown,
    agent: ClaudeProvider | GeminiProvider | OpenRouterProvider
  ): ClassifiedProviderError | null {
    try {
      if (agent instanceof ClaudeProvider) {
        return classifyClaudeError(error);
      }
      if (agent instanceof GeminiProvider) {
        // Without a status code we still want network/spawn detection.
        return classifyGeminiError({ cause: error });
      }
      if (agent instanceof OpenRouterProvider) {
        return classifyOpenRouterError({ cause: error });
      }
    } catch {
      // If the classifier itself throws, fall back to unclassified.
    }
    return null;
  }

  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string
  ): void {
    if (!session) return;

    const sid = session.sessionDbId;
    const agent = this.getActiveAgent();
    const providerName = agent.constructor.name;

    if (session.abortController.signal.aborted) {
      logger.debug('SYSTEM', 'Replacing aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    let hadUnrecoverableError = false;
    let sessionFailed = false;

    logger.info('SYSTEM', `Starting generator (${source}) using ${providerName}`, { sessionId: sid });

    session.lastGeneratorActivity = Date.now();

    session.generatorPromise = agent.startSession(session, this)
      .catch(async (error: unknown) => {
        const errorMessage = (error as Error)?.message || '';

        // Dispatch on F4 ClassifiedProviderError.kind. Replaces the old
        // string-matching allowlist (#2244). Already-classified errors
        // propagate kind from the provider boundary; raw errors get
        // re-classified here using provider-specific helpers based on the
        // active agent.
        const classified: ClassifiedProviderError | null = isClassified(error)
          ? error
          : this.reclassifyAtDispatch(error, agent);

        // FOREIGN KEY constraint failures from SQLite are unrecoverable but
        // not provider-specific; check before deferring to the classifier so
        // FK failures don't get misclassified as transient and retry forever
        // (per-provider classifiers don't recognize FK errors).
        const isFkConstraintFailure = errorMessage.includes('FOREIGN KEY constraint failed');

        const dispatchKind: ProviderErrorClass | null = isFkConstraintFailure
          ? 'unrecoverable'
          : (classified ? classified.kind : null);

        if (dispatchKind === 'unrecoverable' || dispatchKind === 'auth_invalid' || dispatchKind === 'quota_exhausted') {
          hadUnrecoverableError = true;
          this.lastAiInteraction = {
            timestamp: Date.now(),
            success: false,
            provider: providerName,
            error: errorMessage,
          };
          const logLabel =
            dispatchKind === 'auth_invalid' ? 'auth invalid' :
            dispatchKind === 'quota_exhausted' ? 'quota exhausted' : 'unrecoverable';
          logger.error('SDK', `Unrecoverable generator error (${logLabel}) - will NOT restart`, {
            sessionId: session.sessionDbId,
            project: session.project,
            errorKind: dispatchKind,
            errorMessage
          });
          return;
        }

        if (this.isSessionTerminatedError(error)) {
          logger.warn('SDK', 'SDK resume failed, falling back to standalone processing', {
            sessionId: session.sessionDbId,
            project: session.project,
            reason: error instanceof Error ? error.message : String(error)
          });
          return this.runFallbackForTerminatedSession(session, error);
        }

        const staleResumePatterns = ['aborted by user', 'No conversation found'];
        if (staleResumePatterns.some(p => errorMessage.includes(p))
            && session.memorySessionId) {
          logger.warn('SDK', 'Detected stale resume failure, clearing memorySessionId for fresh start', {
            sessionId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            errorMessage
          });
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
        if (!sessionFailed && !hadUnrecoverableError) {
          this.lastAiInteraction = {
            timestamp: Date.now(),
            success: true,
            provider: providerName,
          };
        }

        // Translate worker-service-specific error flags into the canonical reason enum.
        let reason = session.abortReason ?? null;
        session.abortReason = null;
        if (hadUnrecoverableError) reason = 'restart-guard';
        if (session.idleTimedOut) {
          session.idleTimedOut = false;
          reason = reason ?? 'idle';
        }

        await handleGeneratorExit(session, reason, {
          sessionManager: this.sessionManager,
          completionHandler: this.completionHandler,
          restartGenerator: (s, source) => this.startSessionProcessor(s, source),
        });
      });
  }

  private static readonly SESSION_TERMINATED_PATTERNS = [
    'process aborted by user',
    'processtransport',
    'not ready for writing',
    'session generator failed',
    'claude code process',
  ] as const;

  private isSessionTerminatedError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const normalized = msg.toLowerCase();
    return WorkerService.SESSION_TERMINATED_PATTERNS.some(
      pattern => normalized.includes(pattern)
    );
  }

  private async runFallbackForTerminatedSession(
    session: ReturnType<typeof this.sessionManager.getSession>,
    _originalError: unknown
  ): Promise<void> {
    if (!session) return;

    const sessionDbId = session.sessionDbId;

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
        if (e instanceof Error) {
          logger.warn('WORKER', 'Fallback Gemini failed, trying OpenRouter', {
            sessionId: sessionDbId,
          });
          logger.error('WORKER', 'Gemini fallback error detail', { sessionId: sessionDbId }, e);
        } else {
          logger.error('WORKER', 'Gemini fallback failed with non-Error', { sessionId: sessionDbId }, new Error(String(e)));
        }
      }
    }

    if (isOpenRouterAvailable()) {
      try {
        await this.openRouterAgent.startSession(session, this);
        return;
      } catch (e) {
        if (e instanceof Error) {
          logger.error('WORKER', 'Fallback OpenRouter failed, will abandon messages', { sessionId: sessionDbId }, e);
        } else {
          logger.error('WORKER', 'Fallback OpenRouter failed with non-Error, will abandon messages', { sessionId: sessionDbId }, new Error(String(e)));
        }
      }
    }

    this.completionHandler.finalizeSession(sessionDbId);
    this.sessionManager.removeSessionImmediate(sessionDbId);
  }

  private terminateSession(sessionDbId: number, reason: string): void {
    logger.info('SYSTEM', 'Session terminated', { sessionId: sessionDbId, reason });

    this.completionHandler.finalizeSession(sessionDbId);

    this.sessionManager.removeSessionImmediate(sessionDbId);
  }

  async shutdown(): Promise<void> {
    if (this.transcriptWatcher) {
      this.transcriptWatcher.stop();
      this.transcriptWatcher = null;
      logger.info('TRANSCRIPT', 'Transcript watcher stopped');
    }

    await performGracefulShutdown({
      server: this.server.getHttpServer(),
      sessionManager: this.sessionManager,
      mcpClient: this.mcpClient,
      dbManager: this.dbManager,
      chromaMcpManager: this.chromaMcpManager || undefined
    });
  }

  broadcastProcessingStatus(): void {
    const queueDepth = this.sessionManager.getTotalActiveWork();
    const isProcessing = queueDepth > 0;
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

export async function ensureWorkerStarted(port: number): Promise<WorkerStartResult> {
  return ensureWorkerStartedShared(port, __filename);
}

async function main() {
  const command = process.argv[2];

  const hookInitiatedCommands = ['start', 'hook', 'restart', '--daemon'];
  if ((hookInitiatedCommands.includes(command) || command === undefined) && isPluginDisabledInClaudeSettings()) {
    process.exit(0);
  }

  const port = getWorkerPort();

  function exitWithStatus(status: 'ready' | 'error', message?: string): never {
    const output = buildStatusOutput(status, message);
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  switch (command) {
    case 'start': {
      const result = await ensureWorkerStarted(port);
      if (result === 'dead') {
        exitWithStatus('error', 'Failed to start worker');
      } else {
        exitWithStatus('ready', result === 'warming' ? 'Worker started; still warming up' : undefined);
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
      const restartFreed = await waitForPortFree(port, 5000);
      if (!restartFreed) {
        console.error('Port still bound after shutdown. Resolve manually.');
        process.exit(1);
      }
      removePidFile();
      const restartPid = spawnDaemon(__filename, port);
      if (restartPid === undefined) {
        console.error('Failed to spawn worker daemon during restart.');
        process.exit(1);
      }
      logger.info('SYSTEM', 'Worker restart spawned', { pid: restartPid });
      process.exit(0);
      break;
    }

    case 'status': {
      const portInUse = await isPortInUse(port);
      const pidInfo = readPidFile();
      if (portInUse && pidInfo) {
        console.log('Worker is running');
        console.log(`  PID: ${pidInfo.pid}`);
        console.log(`  Port: ${pidInfo.port}`);
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

    case 'gemini-cli': {
      const geminiSubcommand = process.argv[3];
      const geminiResult = await handleGeminiCliCommand(geminiSubcommand, process.argv.slice(4));
      process.exit(geminiResult);
      break;
    }

    case 'hook': {
      const platform = process.argv[3];
      const event = process.argv[4];
      if (!platform || !event) {
        console.error('Usage: claude-mem hook <platform> <event>');
        console.error('Platforms: claude-code, cursor, gemini-cli, raw');
        console.error('Events: context, session-init, observation, summarize, user-message');
        process.exit(1);
      }

      const workerStartResult = await ensureWorkerStarted(port);
      if (workerStartResult === 'dead') {
        logger.warn('SYSTEM', 'Worker failed to start before hook, handler will proceed gracefully');
      }

      const { hookCommand } = await import('../cli/hook-command.js');
      await hookCommand(platform, event);
      break;
    }

    case 'generate': {
      const dryRun = process.argv.includes('--dry-run');
      const { generateClaudeMd } = await import('../cli/claude-md-commands.js');
      const result = await generateClaudeMd(dryRun);
      process.exit(result);
      break;
    }

    case 'clean': {
      const dryRun = process.argv.includes('--dry-run');
      const { cleanClaudeMd } = await import('../cli/claude-md-commands.js');
      const result = await cleanClaudeMd(dryRun);
      process.exit(result);
      break;
    }

    case 'adopt': {
      const dryRun = process.argv.includes('--dry-run');
      const branchIndex = process.argv.indexOf('--branch');
      const branchValue = branchIndex !== -1 ? process.argv[branchIndex + 1] : undefined;
      if (branchIndex !== -1 && (!branchValue || branchValue.startsWith('--'))) {
        console.error('Usage: adopt [--dry-run] [--branch <branch>] [--cwd <path>]');
        process.exit(1);
      }
      const onlyBranch = branchValue;
      const cwdIndex = process.argv.indexOf('--cwd');
      const cwdValue = cwdIndex !== -1 ? process.argv[cwdIndex + 1] : undefined;
      if (cwdIndex !== -1 && (!cwdValue || cwdValue.startsWith('--'))) {
        console.error('Usage: adopt [--dry-run] [--branch <branch>] [--cwd <path>]');
        process.exit(1);
      }
      const repoPath = cwdValue ?? process.cwd();

      const result = await adoptMergedWorktrees({ repoPath, dryRun, onlyBranch });

      const tag = result.dryRun ? '(dry-run)' : '(applied)';
      console.log(`\nWorktree adoption ${tag}`);
      console.log(`  Parent project:       ${result.parentProject || '(unknown)'}`);
      console.log(`  Repo:                 ${result.repoPath}`);
      console.log(`  Worktrees scanned:    ${result.scannedWorktrees}`);
      console.log(`  Merged branches:      ${result.mergedBranches.join(', ') || '(none)'}`);
      console.log(`  Observations adopted: ${result.adoptedObservations}`);
      console.log(`  Summaries adopted:    ${result.adoptedSummaries}`);
      console.log(`  Chroma docs updated:  ${result.chromaUpdates}`);
      if (result.chromaFailed > 0) {
        console.log(`  Chroma sync failures: ${result.chromaFailed} (will retry on next run)`);
      }
      for (const err of result.errors) {
        console.log(`  ! ${err.worktree}: ${err.error}`);
      }
      process.exit(0);
    }

    case 'cleanup': {
      const dryRun = process.argv.includes('--dry-run');
      const counts = runOneTimeV12_4_3Cleanup(undefined, { dryRun });
      const tag = dryRun ? '(dry-run, no changes made)' : '(applied)';
      console.log(`\nv12.4.3 cleanup ${tag}`);
      if (counts) {
        console.log(`  Observer sessions:        ${counts.observerSessions}`);
        console.log(`  Observer cascade rows:    ${counts.observerCascadeRows}`);
        console.log(`  Stuck pending_messages:   ${counts.stuckPendingMessages}`);
      } else if (dryRun) {
        console.log('  Scan failed — see worker log for details.');
      } else {
        console.log('  Already applied (marker present) or skipped.');
      }
      process.exit(0);
    }

    case '--daemon':
    default: {
      const existingPidInfo = readPidFile();
      if (verifyPidFileOwnership(existingPidInfo)) {
        logger.info('SYSTEM', 'Worker already running (PID alive), refusing to start duplicate', {
          existingPid: existingPidInfo.pid,
          existingPort: existingPidInfo.port,
          startedAt: existingPidInfo.startedAt
        });
        process.exit(0);
      }

      if (await isPortInUse(port)) {
        logger.info('SYSTEM', 'Port already in use, refusing to start duplicate', { port });
        process.exit(0);
      }

      process.on('unhandledRejection', (reason) => {
        logger.error('SYSTEM', 'Unhandled rejection in daemon', {
          reason: reason instanceof Error ? reason.message : String(reason)
        });
      });
      process.on('uncaughtException', (error) => {
        logger.error('SYSTEM', 'Uncaught exception in daemon', {}, error as Error);
        // Don't exit — keep the HTTP server running
      });

      const worker = new WorkerService();
      worker.start().catch(async (error) => {
        const isPortConflict = error instanceof Error && (
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ||
          /port.*in use|address.*in use/i.test(error.message)
        );
        if (isPortConflict && await waitForHealth(port, 3000)) {
          logger.info('SYSTEM', 'Duplicate daemon exiting — another worker already claimed port', { port });
          process.exit(0);
        }
        logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
        removePidFile();
        process.exit(0);
      });
    }
  }
}

const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module || !module.parent || process.env.CLAUDE_MEM_MANAGED === 'true'
  : import.meta.url === `file://${process.argv[1]}`
    || process.argv[1]?.endsWith('worker-service')
    || process.argv[1]?.endsWith('worker-service.cjs')
    || process.argv[1]?.replaceAll('\\', '/') === __filename?.replaceAll('\\', '/');

if (isMainModule) {
  main().catch((error) => {
    logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
    process.exit(0);  
  });
}
