/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { z } from 'zod';
import { ingestObservation } from '../shared.js';
import { validateBody } from '../middleware/validateBody.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt, isInternalProtocolPayload } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SDKAgent } from '../../SDKAgent.js';
import { GeminiAgent, isGeminiSelected, isGeminiAvailable } from '../../GeminiAgent.js';
import { OpenRouterAgent, isOpenRouterSelected, isOpenRouterAvailable } from '../../OpenRouterAgent.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { PrivacyCheckValidator } from '../../validation/PrivacyCheckValidator.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../../supervisor/process-registry.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { RestartGuard } from '../../RestartGuard.js';

const MAX_USER_PROMPT_BYTES = 256 * 1024;

export class SessionRoutes extends BaseRouteHandler {
  private spawnInProgress = new Map<number, boolean>();
  private crashRecoveryScheduled = new Set<number>();

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private geminiAgent: GeminiAgent,
    private openRouterAgent: OpenRouterAgent,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService,
    private completionHandler: SessionCompletionHandler,
  ) {
    super();
  }

  /**
   * Get the appropriate agent based on settings
   * Throws error if provider is selected but not configured (no silent fallback)
   *
   * Note: Session linking via contentSessionId allows provider switching mid-session.
   * The conversationHistory on ActiveSession maintains context across providers.
   */
  private getActiveAgent(): SDKAgent | GeminiAgent | OpenRouterAgent {
    if (isOpenRouterSelected()) {
      if (isOpenRouterAvailable()) {
        logger.debug('SESSION', 'Using OpenRouter agent');
        return this.openRouterAgent;
      } else {
        throw new Error('OpenRouter provider selected but no API key configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }
    }
    if (isGeminiSelected()) {
      if (isGeminiAvailable()) {
        logger.debug('SESSION', 'Using Gemini agent');
        return this.geminiAgent;
      } else {
        throw new Error('Gemini provider selected but no API key configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }
    }
    return this.sdkAgent;
  }

  /**
   * Get the currently selected provider name
   */
  private getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' {
    if (isOpenRouterSelected() && isOpenRouterAvailable()) {
      return 'openrouter';
    }
    return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
  }

  /**
   * Ensures agent generator is running for a session
   * Auto-starts if not already running to process pending queue
   * Uses either Claude SDK or Gemini based on settings
   *
   * Provider switching: If provider setting changed while generator is running,
   * we let the current generator finish naturally (max 5s linger timeout).
   * The next generator will use the new provider with shared conversationHistory.
   */
  private static readonly STALE_GENERATOR_THRESHOLD_MS = 30_000; // 30 seconds (#1099)

  // Wall-clock cap on a single in-memory session — exists to prevent runaway
  // API costs from a session that is somehow stuck in a re-activation loop
  // (#1590, #2127, #2098). 4h was the original value, picked when bugs in the
  // re-activation path made cost runaways more plausible; users in practice
  // have legitimate long-running sessions (24h+ Claude Code days) that this
  // killed without warning. 24h is the new ceiling — long enough that
  // a real human workday never hits it, short enough that a runaway loop is
  // still bounded. We deliberately do NOT expose this as a config knob: a
  // session approaching this age is almost certainly a bug worth investigating,
  // not a knob worth tuning.
  private static readonly MAX_SESSION_WALL_CLOCK_MS = 24 * 60 * 60 * 1000; // 24 hours (#1590, #2127)

  public ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    // Wall-clock age guard: refuse to start new generators for sessions that have
    // been alive too long to prevent runaway API costs (Issue #1590).
    // Use the persisted started_at_epoch from the DB so the guard survives worker
    // restarts (session.startTime is reset to Date.now() on every re-activation).
    const dbSessionRecord = this.dbManager.getSessionStore().db
      .prepare('SELECT started_at_epoch FROM sdk_sessions WHERE id = ? LIMIT 1')
      .get(sessionDbId) as { started_at_epoch: number } | undefined;
    const sessionOriginMs = dbSessionRecord?.started_at_epoch ?? session.startTime;
    const sessionAgeMs = Date.now() - sessionOriginMs;
    if (sessionAgeMs > SessionRoutes.MAX_SESSION_WALL_CLOCK_MS) {
      logger.warn('SESSION', 'Session exceeded wall-clock age limit — aborting to prevent runaway spend', {
        sessionId: sessionDbId,
        ageHours: Math.round(sessionAgeMs / 3_600_000 * 10) / 10,
        limitHours: SessionRoutes.MAX_SESSION_WALL_CLOCK_MS / 3_600_000,
        source
      });
      if (!session.abortController.signal.aborted) {
        session.abortController.abort();
      }
      const pendingStore = this.sessionManager.getPendingMessageStore();
      pendingStore.transitionMessagesTo('abandoned', { sessionDbId });
      this.sessionManager.removeSessionImmediate(sessionDbId);
      return;
    }

    // GUARD: Prevent duplicate spawns
    if (this.spawnInProgress.get(sessionDbId)) {
      logger.debug('SESSION', 'Spawn already in progress, skipping', { sessionDbId, source });
      return;
    }

    const selectedProvider = this.getSelectedProvider();

    // Start generator if not running
    if (!session.generatorPromise) {
      // Apply tier routing before starting the generator
      this.applyTierRouting(session);
      this.spawnInProgress.set(sessionDbId, true);
      this.startGeneratorWithProvider(session, selectedProvider, source);
      return;
    }

    // Generator is running - check if stale (no activity for 30s) to prevent queue stall (#1099)
    const timeSinceActivity = Date.now() - session.lastGeneratorActivity;
    if (timeSinceActivity > SessionRoutes.STALE_GENERATOR_THRESHOLD_MS) {
      logger.warn('SESSION', 'Stale generator detected, aborting to prevent queue stall (#1099)', {
        sessionId: sessionDbId,
        timeSinceActivityMs: timeSinceActivity,
        thresholdMs: SessionRoutes.STALE_GENERATOR_THRESHOLD_MS,
        source
      });
      // Abort the stale generator and reset state
      session.abortController.abort();
      session.generatorPromise = null;
      session.abortController = new AbortController();
      session.lastGeneratorActivity = Date.now();
      // Start a fresh generator
      this.applyTierRouting(session);
      this.spawnInProgress.set(sessionDbId, true);
      this.startGeneratorWithProvider(session, selectedProvider, 'stale-recovery');
      return;
    }

    // Generator is running - check if provider changed
    if (session.currentProvider && session.currentProvider !== selectedProvider) {
      logger.info('SESSION', `Provider changed, will switch after current generator finishes`, {
        sessionId: sessionDbId,
        currentProvider: session.currentProvider,
        selectedProvider,
        historyLength: session.conversationHistory.length
      });
      // Let current generator finish naturally, next one will use new provider
      // The shared conversationHistory ensures context is preserved
    }
  }

  /**
   * Start a generator with the specified provider
   */
  private startGeneratorWithProvider(
    session: ReturnType<typeof this.sessionManager.getSession>,
    provider: 'claude' | 'gemini' | 'openrouter',
    source: string
  ): void {
    if (!session) return;

    // Reset AbortController if it was previously aborted
    // This fixes the bug where a session gets stuck in an infinite "Generator aborted" loop
    // after its AbortController was aborted (e.g., from a previous generator exit)
    if (session.abortController.signal.aborted) {
      logger.debug('SESSION', 'Resetting aborted AbortController before starting generator', {
        sessionId: session.sessionDbId
      });
      session.abortController = new AbortController();
    }

    const agent = provider === 'openrouter' ? this.openRouterAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

    // Use database count for accurate telemetry (in-memory array is always empty due to FK constraint fix)
    const pendingStore = this.sessionManager.getPendingMessageStore();
    const actualQueueDepth = pendingStore.getPendingCount(session.sessionDbId);

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: actualQueueDepth,
      historyLength: session.conversationHistory.length
    });

    // Track which provider is running and mark activity for stale detection (#1099)
    session.currentProvider = provider;
    session.lastGeneratorActivity = Date.now();

    // Capture the AbortController that belongs to THIS generator run.
    // session.abortController may be replaced (e.g. by stale-recovery) before the
    // .catch / .finally handlers run, so binding it here prevents a stale rejection
    // from cancelling a brand-new controller (race condition guard).
    const myController = session.abortController;

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        // Only log non-abort errors
        if (myController.signal.aborted) {
          logger.debug('HTTP', 'Generator catch: ignoring error after abort', { sessionId: session.sessionDbId });
          return;
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        // Treat SIGTERM (exit code 143) as intentional termination, not a crash.
        // When a subprocess is killed externally, abort the controller to prevent
        // crash recovery from immediately respawning the process (Issue #1590).
        // APPROVED OVERRIDE
        if (errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM')) {
          logger.warn('SESSION', 'Generator killed by external signal — aborting session to prevent respawn', {
            sessionId: session.sessionDbId,
            provider,
            error: errorMsg
          });
          myController.abort();
          return;
        }

        logger.error('SESSION', `Generator failed`, {
          sessionId: session.sessionDbId,
          provider: provider,
          error: errorMsg
        }, error);

        // Mark all processing messages as failed so they can be retried or abandoned
        const pendingStore = this.sessionManager.getPendingMessageStore();
        try {
          const failedCount = pendingStore.transitionMessagesTo('failed', { sessionDbId: session.sessionDbId });
          if (failedCount > 0) {
            logger.error('SESSION', `Marked messages as failed after generator error`, {
              sessionId: session.sessionDbId,
              failedCount
            });
          }
        } catch (dbError) {
          const normalizedDbError = dbError instanceof Error ? dbError : new Error(String(dbError));
          logger.error('HTTP', 'Failed to mark messages as failed', {
            sessionId: session.sessionDbId
          }, normalizedDbError);
        }
      })
      .finally(async () => {
        // Primary-path subprocess teardown — process-group kill ensures any
        // SDK descendants are reaped too (Principle 5).
        const tracked = getSdkProcessForSession(session.sessionDbId);
        if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
          await ensureSdkProcessExit(tracked, 5000);
        }

        const sessionDbId = session.sessionDbId;
        this.spawnInProgress.delete(sessionDbId);
        const wasAborted = session.abortController.signal.aborted;

        if (wasAborted) {
          logger.info('SESSION', `Generator aborted`, { sessionId: sessionDbId });

          // #2192: when the generator aborts (idle timeout, user cancel,
          // shutdown) with rows already claimed and yielded but not yet
          // confirmed by ResponseProcessor, those rows sit in 'processing'
          // under THIS worker's PID. The self-healing claim predicate skips
          // them because the worker is still alive — the queue deadlocks
          // until the worker restarts. Walk the in-flight ids and run them
          // through markFailed so the retry ladder requeues them or marks
          // them terminally failed.
          const inflightStore = this.sessionManager.getPendingMessageStore();
          const inflightIds = session.processingMessageIds.slice();
          session.processingMessageIds = [];
          for (const messageId of inflightIds) {
            try {
              inflightStore.markFailed(messageId);
            } catch (markErr) {
              const normalized = markErr instanceof Error ? markErr : new Error(String(markErr));
              logger.error('SESSION', 'Failed to requeue in-flight message after abort', {
                sessionId: sessionDbId,
                messageId,
              }, normalized);
            }
          }
        }
        // Don't log "exited unexpectedly" here — a non-abort exit is normal when
        // the SDK subprocess completes its work. The crash-recovery block below
        // checks pendingCount to distinguish real crashes from clean exits (#1876).

        session.generatorPromise = null;
        session.currentProvider = null;
        this.workerService.broadcastProcessingStatus();

        // Crash recovery: If not aborted and still has work, restart (with limit)
        if (!wasAborted) {
          const pendingStore = this.sessionManager.getPendingMessageStore();

          let pendingCount: number;
          try {
            pendingCount = pendingStore.getPendingCount(sessionDbId);
          } catch (e) {
            const normalizedRecoveryError = e instanceof Error ? e : new Error(String(e));
            logger.error('HTTP', 'Error during recovery check, aborting to prevent leaks', { sessionId: sessionDbId }, normalizedRecoveryError);
            session.abortController.abort();
            return;
          }

          if (pendingCount > 0) {
            // GUARD: Prevent duplicate crash recovery spawns
            if (this.crashRecoveryScheduled.has(sessionDbId)) {
              logger.debug('SESSION', 'Crash recovery already scheduled', { sessionDbId });
              return;
            }

            // Windowed restart guard: only blocks tight-loop restarts, not spread-out ones (#2053)
            if (!session.restartGuard) session.restartGuard = new RestartGuard();
            const restartAllowed = session.restartGuard.recordRestart();
            session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1; // Keep for logging

            if (!restartAllowed) {
              logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, draining pending messages and terminating`, {
                sessionId: sessionDbId,
                pendingCount,
                restartsInWindow: session.restartGuard.restartsInWindow,
                windowMs: session.restartGuard.windowMs,
                maxRestarts: session.restartGuard.maxRestarts,
                consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
                maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
                action: 'Generator will NOT restart. Pending messages drained to abandoned. Check logs for root cause.'
              });
              // Don't restart - abort to prevent further API calls AND drain pending
              // messages so the session doesn't reappear in getSessionsWithPendingMessages
              // and trigger another auto-start cycle.
              session.abortController.abort();
              try {
                const drained = pendingStore.transitionMessagesTo('abandoned', { sessionDbId });
                if (drained > 0) {
                  logger.error('SESSION', 'Drained pending messages to abandoned after restart guard trip', {
                    sessionId: sessionDbId,
                    drained,
                  });
                }
              } catch (drainErr) {
                const normalized = drainErr instanceof Error ? drainErr : new Error(String(drainErr));
                logger.error('SESSION', 'Failed to drain pending messages after restart guard trip', {
                  sessionId: sessionDbId,
                }, normalized);
              }
              return;
            }

            logger.info('SESSION', `Restarting generator after crash/exit with pending work`, {
              sessionId: sessionDbId,
              pendingCount,
              consecutiveRestarts: session.consecutiveRestarts,
              restartsInWindow: session.restartGuard!.restartsInWindow,
              maxRestarts: session.restartGuard!.maxRestarts,
              consecutiveFailures: session.restartGuard!.consecutiveFailuresSinceSuccess,
              maxConsecutiveFailures: session.restartGuard!.maxConsecutiveFailures
            });

            // Abort OLD controller before replacing to prevent child process leaks
            const oldController = session.abortController;
            session.abortController = new AbortController();
            oldController.abort();

            this.crashRecoveryScheduled.add(sessionDbId);

            // Exponential backoff: 1s, 2s, 4s for subsequent restarts
            const backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveRestarts - 1), 8000);

            // Delay before restart with exponential backoff
            setTimeout(() => {
              this.crashRecoveryScheduled.delete(sessionDbId);
              const stillExists = this.sessionManager.getSession(sessionDbId);
              if (stillExists && !stillExists.generatorPromise) {
                this.applyTierRouting(stillExists);
                this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
              }
            }, backoffMs);
          } else {
            // No pending work - abort to kill the child process
            session.abortController.abort();
            // Reset restart counter on successful completion
            session.consecutiveRestarts = 0;
            logger.debug('SESSION', 'Aborted controller after natural completion', {
              sessionId: sessionDbId
            });
          }
        }
        // NOTE: We do NOT delete the session here anymore.
        // The generator waits for events, so if it exited, it's either aborted or crashed.
        // Idle sessions stay in memory (ActiveSession is small) to listen for future events.
      });
  }

  setupRoutes(app: express.Application): void {
    // Legacy session endpoints (use sessionDbId)
    app.post(
      '/sessions/:sessionDbId/init',
      validateBody(SessionRoutes.legacySessionInitSchema),
      this.handleSessionInit.bind(this)
    );
    app.post(
      '/sessions/:sessionDbId/observations',
      validateBody(SessionRoutes.legacyObservationsSchema),
      this.handleObservations.bind(this)
    );
    app.post(
      '/sessions/:sessionDbId/summarize',
      validateBody(SessionRoutes.legacySummarizeSchema),
      this.handleSummarize.bind(this)
    );
    app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // New session endpoints (use contentSessionId)
    app.post(
      '/api/sessions/init',
      validateBody(SessionRoutes.sessionInitByClaudeIdSchema),
      this.handleSessionInitByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/observations',
      validateBody(SessionRoutes.observationsByClaudeIdSchema),
      this.handleObservationsByClaudeId.bind(this)
    );
    app.post(
      '/api/sessions/summarize',
      validateBody(SessionRoutes.summarizeByClaudeIdSchema),
      this.handleSummarizeByClaudeId.bind(this)
    );
    app.get('/api/sessions/status', this.handleStatusByClaudeId.bind(this));
  }

  // Plan 06 Phase 3 — per-route Zod schemas. Schemas live at the top of the
  // owning route file and gate body validation via `validateBody`.
  // `passthrough()` preserves optional/forwarded fields the handlers
  // already accept (e.g. cwd, agentId, agentType, platformSource).
  private static readonly legacySessionInitSchema = z.object({
    userPrompt: z.string().optional(),
    promptNumber: z.number().int().optional(),
  }).passthrough();

  private static readonly legacyObservationsSchema = z.object({
    tool_name: z.string().min(1),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    prompt_number: z.number().int().optional(),
    cwd: z.string().optional(),
  }).passthrough();

  private static readonly legacySummarizeSchema = z.object({
    last_assistant_message: z.string().optional(),
  }).passthrough();

  private static readonly sessionInitByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    project: z.string().optional(),
    prompt: z.string().optional(),
    platformSource: z.string().optional(),
    customTitle: z.string().optional(),
  }).passthrough();

  private static readonly observationsByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    tool_name: z.string().min(1),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    cwd: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    platformSource: z.string().optional(),
    // Idempotency key for the UNIQUE(content_session_id, tool_use_id) index
    // added in Plan 01 Phase 1. Accept both snake and camel shapes so
    // cross-process callers using either convention still deduplicate.
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
  }).passthrough();

  private static readonly summarizeByClaudeIdSchema = z.object({
    contentSessionId: z.string().min(1),
    last_assistant_message: z.string().optional(),
    agentId: z.string().optional(),
    platformSource: z.string().optional(),
  }).passthrough();

  /**
   * Initialize a new session
   */
  private handleSessionInit = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { userPrompt, promptNumber } = req.body;
    logger.info('HTTP', 'SessionRoutes: handleSessionInit called', {
      sessionDbId,
      promptNumber,
      has_userPrompt: !!userPrompt
    });

    const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = this.dbManager.getSessionStore().getLatestUserPrompt(session.contentSessionId);

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      this.eventBroadcaster.broadcastNewPrompt({
        id: latestPrompt.id,
        content_session_id: latestPrompt.content_session_id,
        project: latestPrompt.project,
        platform_source: latestPrompt.platform_source,
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });

      // Sync user prompt to Chroma
      const chromaStart = Date.now();
      const promptText = latestPrompt.prompt_text;
      this.dbManager.getChromaSync()?.syncUserPrompt(
        latestPrompt.id,
        latestPrompt.memory_session_id,
        latestPrompt.project,
        promptText,
        latestPrompt.prompt_number,
        latestPrompt.created_at_epoch
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        const truncatedPrompt = promptText.length > 60
          ? promptText.substring(0, 60) + '...'
          : promptText;
        logger.debug('CHROMA', 'User prompt synced', {
          promptId: latestPrompt.id,
          duration: `${chromaDuration}ms`,
          prompt: truncatedPrompt
        });
      }).catch((error) => {
        logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
          promptId: latestPrompt.id,
          prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
        }, error);
      });
    }

    // Idempotent: ensure generator is running (matches handleObservations / handleSummarize)
    this.ensureGeneratorRunning(sessionDbId, 'init');

    // Broadcast session started event
    this.eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);

    res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
  });

  /**
   * Queue observations for processing
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleObservations = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { tool_name, tool_input, tool_response, prompt_number, cwd } = req.body;

    this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input,
      tool_response,
      prompt_number,
      cwd
    });

    // CRITICAL: Ensure SDK agent is running to consume the queue
    this.ensureGeneratorRunning(sessionDbId, 'observation');

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize request
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleSummarize = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { last_assistant_message } = req.body;

    const cleanedLastAssistantMessage = last_assistant_message
      ? stripMemoryTagsFromPrompt(String(last_assistant_message))
      : last_assistant_message;
    this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);

    // CRITICAL: Ensure SDK agent is running to consume the queue
    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  /**
   * Get session status
   */
  private handleSessionStatus = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const session = this.sessionManager.getSession(sessionDbId);

    if (!session) {
      res.json({ status: 'not_found' });
      return;
    }

    // Use database count for accurate queue length (in-memory array is always empty due to FK constraint fix)
    const pendingStore = this.sessionManager.getPendingMessageStore();
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    res.json({
      status: 'active',
      sessionDbId,
      project: session.project,
      queueLength,
      uptime: Date.now() - session.startTime
    });
  });

  /**
   * Delete a session
   */
  private handleSessionDelete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    await this.completionHandler.completeByDbId(sessionDbId);

    res.json({ status: 'deleted' });
  });

  /**
   * Complete a session (backward compatibility for cleanup-hook)
   * cleanup-hook expects POST /sessions/:sessionDbId/complete instead of DELETE
   */
  private handleSessionComplete = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    await this.completionHandler.completeByDbId(sessionDbId);

    res.json({ success: true });
  });

  /**
   * Queue observations by contentSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { contentSessionId, tool_name, tool_input, tool_response, cwd }
   */
  private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const {
      contentSessionId,
      tool_name,
      tool_input,
      tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      tool_use_id,
      toolUseId,
    } = req.body;

    const result = ingestObservation({
      contentSessionId,
      toolName: tool_name,
      toolInput: tool_input,
      toolResponse: tool_response,
      cwd,
      platformSource,
      agentId,
      agentType,
      toolUseId: typeof tool_use_id === 'string' ? tool_use_id : (typeof toolUseId === 'string' ? toolUseId : undefined),
    });

    if (!result.ok) {
      res.status(result.status ?? 500).json({ stored: false, reason: result.reason });
      return;
    }

    if ('status' in result && result.status === 'skipped') {
      res.json({ status: 'skipped', reason: result.reason });
      return;
    }

    res.json({ status: 'queued' });
  });

  /**
   * Queue summarize by contentSessionId (summary-hook uses this)
   * POST /api/sessions/summarize
   * Body: { contentSessionId, last_assistant_message }
   *
   * Checks privacy, queues summarize request for SDK agent
   */
  private handleSummarizeByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, last_assistant_message, agentId } = req.body;
    const platformSource = normalizePlatformSource(req.body.platformSource);

    // Belt-and-suspenders: reject summarize requests from subagent context.
    // Gate on agentId only — agentType alone indicates a main session started with
    // --agent, which still owns its summary. Mirrors the hook-side guard in summarize.ts.
    if (agentId) {
      res.json({ status: 'skipped', reason: 'subagent_context' });
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '', undefined, platformSource);
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'summarize',
      sessionDbId
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Queue summarize
    const cleanedLastAssistantMessage = last_assistant_message
      ? stripMemoryTagsFromPrompt(String(last_assistant_message))
      : last_assistant_message;
    this.sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage);

    // Ensure SDK agent is running
    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  /**
   * Get session status by contentSessionId (summarize handler polls this)
   * GET /api/sessions/status?contentSessionId=...
   *
   * Returns queue depth so the Stop hook can wait for summary completion.
   */
  private handleStatusByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const contentSessionId = req.query.contentSessionId as string;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId query parameter');
    }

    const store = this.dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const session = this.sessionManager.getSession(sessionDbId);

    if (!session) {
      res.json({ status: 'not_found', queueLength: 0 });
      return;
    }

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    res.json({
      status: 'active',
      sessionDbId,
      queueLength,
      // Expose whether the last storage operation included a summary record.
      // The Stop hook uses this to detect silent summary loss when the queue empties (#1633).
      summaryStored: session.lastSummaryStored ?? null,
      uptime: Date.now() - session.startTime
    });
  });

  /**
   * Initialize session by contentSessionId (new-hook uses this)
   * POST /api/sessions/init
   * Body: { contentSessionId, project, prompt }
   *
   * Performs all session initialization DB operations:
   * - Creates/gets SDK session (idempotent)
   * - Increments prompt counter
   * - Saves user prompt (with privacy tag stripping)
   *
   * Returns: { sessionDbId, promptNumber, skipped: boolean, reason?: string }
   */
  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId } = req.body;

    // Only contentSessionId is truly required — Cursor and other platforms
    // may omit prompt/project in their payload (#838, #1049)
    const project = req.body.project || 'unknown';
    const rawPrompt = typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
    const platformSource = normalizePlatformSource(req.body.platformSource);
    const customTitle = req.body.customTitle || undefined;

    // Filter on the raw prompt before truncation / [media prompt] substitution
    // so the check is independent of those transforms.
    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HTTP', 'session-init: skipping internal protocol payload before session creation', { contentSessionId });
      res.json({ skipped: true, reason: 'internal_protocol' });
      return;
    }

    let prompt = rawPrompt || '[media prompt]';

    const promptByteLength = Buffer.byteLength(prompt, 'utf8');
    if (promptByteLength > MAX_USER_PROMPT_BYTES) {
      logger.warn('HTTP', 'SessionRoutes: oversized prompt truncated at session-init boundary', {
        project,
        contentSessionId,
        promptByteLength,
        maxBytes: MAX_USER_PROMPT_BYTES,
        preview: prompt.slice(0, 200)
      });
      const buf = Buffer.from(prompt, 'utf8');
      let end = MAX_USER_PROMPT_BYTES;
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
      prompt = buf.subarray(0, end).toString('utf8');
    }

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      platformSource,
      prompt_length: prompt?.length,
      customTitle
    });

    const store = this.dbManager.getSessionStore();

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource);

    // Verify session creation with DB lookup
    const dbSession = store.getSessionById(sessionDbId);
    const isNewSession = !dbSession?.memory_session_id;
    logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
      sessionId: sessionDbId
    });

    // Step 2: Get next prompt number from user_prompts count
    const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId);
    const promptNumber = currentCount + 1;

    // Debug-level alignment logs for detailed tracing
    const memorySessionId = dbSession?.memory_session_id || null;
    if (promptNumber > 1) {
      logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
    } else {
      logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
    }

    // Step 3: Strip privacy tags from prompt
    const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

    // Step 4: Check if prompt is entirely private
    if (!cleanedPrompt || cleanedPrompt.trim() === '') {
      logger.debug('HOOK', 'Session init - prompt entirely private', {
        sessionId: sessionDbId,
        promptNumber,
        originalLength: prompt.length
      });

      res.json({
        sessionDbId,
        promptNumber,
        skipped: true,
        reason: 'private'
      });
      return;
    }

    // Step 5: Save cleaned user prompt
    store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt);

    // Step 6: Check if SDK agent is already running for this session (#1079)
    // If contextInjected is true, the hook should skip re-initializing the SDK agent
    const contextInjected = this.sessionManager.getSession(sessionDbId) !== undefined;

    // Debug-level log since CREATED already logged the key info
    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber,
      contextInjected
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false,
      contextInjected
    });
  });

  // Simple tool names that produce low-complexity observations
  private static readonly SIMPLE_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'LS', 'ListMcpResourcesTool'
  ]);

  /**
   * Apply tier routing: select model based on pending queue complexity.
   * - Summarize in queue → summary model (e.g., Opus)
   * - All simple tools → simple model (e.g., Haiku)
   * - Otherwise → default model (no override)
   */
  private applyTierRouting(session: NonNullable<ReturnType<typeof this.sessionManager.getSession>>): void {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_TIER_ROUTING_ENABLED === 'false') {
      session.modelOverride = undefined;
      return;
    }

    // Clear stale override before re-evaluating — prevents previous tier
    // from persisting when queue composition changes between spawns.
    session.modelOverride = undefined;

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const pending = pendingStore.peekPendingTypes(session.sessionDbId);

    if (pending.length === 0) {
      session.modelOverride = undefined;
      return;
    }

    const hasSummarize = pending.some(m => m.message_type === 'summarize');
    const allSimple = pending.every(m =>
      m.message_type === 'observation' && m.tool_name && SessionRoutes.SIMPLE_TOOLS.has(m.tool_name)
    );

    if (hasSummarize) {
      const summaryModel = settings.CLAUDE_MEM_TIER_SUMMARY_MODEL;
      if (summaryModel) {
        session.modelOverride = summaryModel;
        logger.debug('SESSION', `Tier routing: summary model`, {
          sessionId: session.sessionDbId, model: summaryModel
        });
      }
    } else if (allSimple) {
      const simpleModel = settings.CLAUDE_MEM_TIER_SIMPLE_MODEL;
      if (simpleModel) {
        session.modelOverride = simpleModel;
        logger.debug('SESSION', `Tier routing: simple model`, {
          sessionId: session.sessionDbId, model: simpleModel
        });
      }
    } else {
      session.modelOverride = undefined;
    }
  }
}
