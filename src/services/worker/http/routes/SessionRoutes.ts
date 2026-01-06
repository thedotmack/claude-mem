/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromJson, stripMemoryTagsFromPrompt } from '../../../../utils/tag-stripping.js';
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

export class SessionRoutes extends BaseRouteHandler {
  private completionHandler: SessionCompletionHandler;

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private geminiAgent: GeminiAgent,
    private openRouterAgent: OpenRouterAgent,
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService
  ) {
    super();
    this.completionHandler = new SessionCompletionHandler(
      sessionManager,
      eventBroadcaster
    );
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
  private ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    if (!session) return;

    const selectedProvider = this.getSelectedProvider();

    // Start generator if not running
    if (!session.generatorPromise) {
      this.startGeneratorWithProvider(session, selectedProvider, source);
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

    const agent = provider === 'openrouter' ? this.openRouterAgent : (provider === 'gemini' ? this.geminiAgent : this.sdkAgent);
    const agentName = provider === 'openrouter' ? 'OpenRouter' : (provider === 'gemini' ? 'Gemini' : 'Claude SDK');

    logger.info('SESSION', `Generator auto-starting (${source}) using ${agentName}`, {
      sessionId: session.sessionDbId,
      queueDepth: session.pendingMessages.length,
      historyLength: session.conversationHistory.length
    });

    // Track which provider is running
    session.currentProvider = provider;

    session.generatorPromise = agent.startSession(session, this.workerService)
      .catch(error => {
        // Only log non-abort errors
        if (session.abortController.signal.aborted) return;
        
        logger.error('SESSION', `Generator failed`, {
          sessionId: session.sessionDbId,
          provider: provider,
          error: error.message
        }, error);

        // Mark all processing messages as failed so they can be retried or abandoned
        const pendingStore = this.sessionManager.getPendingMessageStore();
        try {
          const failedCount = pendingStore.markSessionMessagesFailed(session.sessionDbId);
          if (failedCount > 0) {
            logger.warn('SESSION', `Marked messages as failed after generator error`, {
              sessionId: session.sessionDbId,
              failedCount
            });
          }
        } catch (dbError) {
          logger.error('SESSION', 'Failed to mark messages as failed', {
            sessionId: session.sessionDbId
          }, dbError as Error);
        }
      })
      .finally(() => {
        const sessionDbId = session.sessionDbId;
        const wasAborted = session.abortController.signal.aborted;

        if (wasAborted) {
          logger.info('SESSION', `Generator aborted`, { sessionId: sessionDbId });
        } else {
          logger.warn('SESSION', `Generator exited unexpectedly`, { sessionId: sessionDbId });
        }

        session.generatorPromise = null;
        session.currentProvider = null;
        this.workerService.broadcastProcessingStatus();

        // Crash recovery: If not aborted and still has work, restart
        if (!wasAborted) {
          try {
            const pendingStore = this.sessionManager.getPendingMessageStore();
            const pendingCount = pendingStore.getPendingCount(sessionDbId);

            if (pendingCount > 0) {
              logger.info('SESSION', `Restarting generator after crash/exit with pending work`, {
                sessionId: sessionDbId,
                pendingCount
              });

              // Create new AbortController for the restarted generator
              session.abortController = new AbortController();

              // Small delay before restart
              setTimeout(() => {
                const stillExists = this.sessionManager.getSession(sessionDbId);
                if (stillExists && !stillExists.generatorPromise) {
                  this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'crash-recovery');
                }
              }, 1000);
            } else {
              // No pending work - abort to kill the child process
              session.abortController.abort();
              logger.debug('SESSION', 'Aborted controller after natural completion', {
                sessionId: sessionDbId
              });
            }
          } catch (e) {
            // Ignore errors during recovery check, but still abort to prevent leaks
            logger.debug('SESSION', 'Error during recovery check, aborting to prevent leaks', { sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e) });
            session.abortController.abort();
          }
        }
        // NOTE: We do NOT delete the session here anymore.
        // The generator waits for events, so if it exited, it's either aborted or crashed.
        // Idle sessions stay in memory (ActiveSession is small) to listen for future events.
      });
  }

  setupRoutes(app: express.Application): void {
    // Legacy session endpoints (use sessionDbId)
    app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // New session endpoints (use contentSessionId)
    app.post('/api/sessions/init', this.handleSessionInitByClaudeId.bind(this));
    app.post('/api/sessions/observations', this.handleObservationsByClaudeId.bind(this));
    app.post('/api/sessions/summarize', this.handleSummarizeByClaudeId.bind(this));
  }

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
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });

      // Sync user prompt to Chroma
      const chromaStart = Date.now();
      const promptText = latestPrompt.prompt_text;
      this.dbManager.getChromaSync().syncUserPrompt(
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
        logger.warn('CHROMA', 'User prompt sync failed, continuing without vector search', {
          promptId: latestPrompt.id,
          prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
        }, error);
      });
    }

    // Start agent in background using the helper method
    this.startGeneratorWithProvider(session, this.getSelectedProvider(), 'init');

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

    this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);

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

    res.json({
      status: 'active',
      sessionDbId,
      project: session.project,
      queueLength: session.pendingMessages.length,
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
    const { contentSessionId, tool_name, tool_input, tool_response, cwd } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    // Load skip tools from settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const skipTools = new Set(settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean));

    // Skip low-value or meta tools
    if (skipTools.has(tool_name)) {
      logger.debug('SESSION', 'Skipping observation for tool', { tool_name });
      res.json({ status: 'skipped', reason: 'tool_excluded' });
      return;
    }

    // Skip meta-observations: file operations on session-memory files
    const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
    if (fileOperationTools.has(tool_name) && tool_input) {
      const filePath = tool_input.file_path || tool_input.notebook_path;
      if (filePath && filePath.includes('session-memory')) {
        logger.debug('SESSION', 'Skipping meta-observation for session-memory file', {
          tool_name,
          file_path: filePath
        });
        res.json({ status: 'skipped', reason: 'session_memory_meta' });
        return;
      }
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      contentSessionId,
      promptNumber,
      'observation',
      sessionDbId,
      { tool_name }
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Strip memory tags from tool_input and tool_response
    const cleanedToolInput = tool_input !== undefined
      ? stripMemoryTagsFromJson(JSON.stringify(tool_input))
      : '{}';

    const cleanedToolResponse = tool_response !== undefined
      ? stripMemoryTagsFromJson(JSON.stringify(tool_response))
      : '{}';

    // Queue observation
    this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input: cleanedToolInput,
      tool_response: cleanedToolResponse,
      prompt_number: promptNumber,
      cwd: cwd || logger.happyPathError(
        'SESSION',
        'Missing cwd when queueing observation in SessionRoutes',
        { sessionId: sessionDbId },
        { tool_name },
        ''
      )
    });

    // Ensure SDK agent is running
    this.ensureGeneratorRunning(sessionDbId, 'observation');

    // Broadcast observation queued event
    this.eventBroadcaster.broadcastObservationQueued(sessionDbId);

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
    const { contentSessionId, last_assistant_message } = req.body;

    if (!contentSessionId) {
      return this.badRequest(res, 'Missing contentSessionId');
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(contentSessionId, '', '');
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
    this.sessionManager.queueSummarize(sessionDbId, last_assistant_message);

    // Ensure SDK agent is running
    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
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
    const { contentSessionId, project, prompt } = req.body;

    logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
      contentSessionId,
      project,
      prompt_length: prompt?.length
    });

    // Validate required parameters
    if (!this.validateRequired(req, res, ['contentSessionId', 'project', 'prompt'])) {
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(contentSessionId, project, prompt);

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

    // Debug-level log since CREATED already logged the key info
    logger.debug('SESSION', 'User prompt saved', {
      sessionId: sessionDbId,
      promptNumber
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false
    });
  });
}
