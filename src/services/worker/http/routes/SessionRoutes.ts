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
    private eventBroadcaster: SessionEventBroadcaster,
    private workerService: WorkerService
  ) {
    super();
    this.completionHandler = new SessionCompletionHandler(
      sessionManager,
      dbManager,
      eventBroadcaster
    );
  }

  /**
   * Ensures SDK agent generator is running for a session
   * Auto-starts if not already running to process pending queue
   */
  private ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    if (session && !session.generatorPromise) {
      logger.info('SESSION', `Generator auto-starting (${source})`, {
        sessionId: sessionDbId,
        queueDepth: session.pendingMessages.length
      });

      session.generatorPromise = this.sdkAgent.startSession(session, this.workerService)
        .finally(() => {
          logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
          session.generatorPromise = null;
          this.workerService.broadcastProcessingStatus();
        });
    }
  }

  setupRoutes(app: express.Application): void {
    // Legacy session endpoints (use sessionDbId)
    app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));
    app.post('/sessions/:sessionDbId/complete', this.handleSessionComplete.bind(this));

    // New session endpoints (use claudeSessionId)
    app.post('/api/sessions/init', this.handleSessionInitByClaudeId.bind(this));
    app.post('/api/sessions/observations', this.handleObservationsByClaudeId.bind(this));
    app.post('/api/sessions/summarize', this.handleSummarizeByClaudeId.bind(this));
    app.post('/api/sessions/complete', this.handleSessionCompleteByClaudeId.bind(this));
    app.post('/api/sessions/waiting', this.handleSessionWaiting.bind(this));
    app.post('/api/sessions/waiting/:id/respond', this.handleWaitingSessionRespond.bind(this));
    app.get('/api/sessions/waiting', this.handleGetWaitingSessions.bind(this));

    // Slack sharing endpoints
    app.post('/api/slack/share/summary', this.handleShareSummary.bind(this));
    app.post('/api/slack/share/observation/:id', this.handleShareObservation.bind(this));
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit = this.wrapHandler((req: Request, res: Response): void => {
    const sessionDbId = this.parseIntParam(req, res, 'sessionDbId');
    if (sessionDbId === null) return;

    const { userPrompt, promptNumber } = req.body;
    const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = this.dbManager.getSessionStore().getLatestUserPrompt(session.claudeSessionId);

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      this.eventBroadcaster.broadcastNewPrompt({
        id: latestPrompt.id,
        claude_session_id: latestPrompt.claude_session_id,
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
        latestPrompt.sdk_session_id,
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

    // Start SDK agent in background (pass worker ref for spinner control)
    logger.info('SESSION', 'Generator starting', {
      sessionId: sessionDbId,
      project: session.project,
      promptNum: session.lastPromptNumber
    });

    session.generatorPromise = this.sdkAgent.startSession(session, this.workerService)
      .finally(() => {
        // Clear generator reference when completed
        logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
        session.generatorPromise = null;
        // Broadcast status change (generator finished, may stop spinner)
        this.workerService.broadcastProcessingStatus();
      });

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

    const { last_user_message, last_assistant_message } = req.body;

    this.sessionManager.queueSummarize(sessionDbId, last_user_message, last_assistant_message);

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
   * Queue observations by claudeSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { claudeSessionId, tool_name, tool_input, tool_response, cwd }
   */
  private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { claudeSessionId, tool_name, tool_input, tool_response, cwd } = req.body;

    if (!claudeSessionId) {
      return this.badRequest(res, 'Missing claudeSessionId');
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
    const sessionDbId = store.createSDKSession(claudeSessionId, '', '');
    const promptNumber = store.getPromptCounter(sessionDbId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      claudeSessionId,
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
   * Queue summarize by claudeSessionId (summary-hook uses this)
   * POST /api/sessions/summarize
   * Body: { claudeSessionId, last_user_message, last_assistant_message }
   *
   * Checks privacy, queues summarize request for SDK agent
   */
  private handleSummarizeByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { claudeSessionId, last_user_message, last_assistant_message } = req.body;

    if (!claudeSessionId) {
      return this.badRequest(res, 'Missing claudeSessionId');
    }

    const store = this.dbManager.getSessionStore();

    // Get or create session
    const sessionDbId = store.createSDKSession(claudeSessionId, '', '');
    const promptNumber = store.getPromptCounter(sessionDbId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
      store,
      claudeSessionId,
      promptNumber,
      'summarize',
      sessionDbId
    );
    if (!userPrompt) {
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Queue summarize
    this.sessionManager.queueSummarize(
      sessionDbId,
      last_user_message || logger.happyPathError(
        'SESSION',
        'Missing last_user_message when queueing summary in SessionRoutes',
        { sessionId: sessionDbId },
        undefined,
        ''
      ),
      last_assistant_message
    );

    // Ensure SDK agent is running
    this.ensureGeneratorRunning(sessionDbId, 'summarize');

    // Broadcast summarize queued event
    this.eventBroadcaster.broadcastSummarizeQueued();

    res.json({ status: 'queued' });
  });

  /**
   * Complete session by claudeSessionId (cleanup-hook uses this)
   * POST /api/sessions/complete
   * Body: { claudeSessionId }
   *
   * Marks session complete, stops SDK agent, broadcasts status
   */
  private handleSessionCompleteByClaudeId = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { claudeSessionId } = req.body;

    if (!claudeSessionId) {
      return this.badRequest(res, 'Missing claudeSessionId');
    }

    const found = await this.completionHandler.completeByClaudeId(claudeSessionId);

    if (!found) {
      // No active session - nothing to clean up (may have already been completed)
      res.json({ success: true, message: 'No active session found' });
      return;
    }

    res.json({ success: true });
  });

  /**
   * Initialize session by claudeSessionId (new-hook uses this)
   * POST /api/sessions/init
   * Body: { claudeSessionId, project, prompt }
   *
   * Performs all session initialization DB operations:
   * - Creates/gets SDK session (idempotent)
   * - Increments prompt counter
   * - Saves user prompt (with privacy tag stripping)
   *
   * Returns: { sessionDbId, promptNumber, skipped: boolean, reason?: string }
   */
  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { claudeSessionId, project, prompt } = req.body;

    // Validate required parameters
    if (!this.validateRequired(req, res, ['claudeSessionId', 'project', 'prompt'])) {
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(claudeSessionId, project, prompt);

    // Step 2: Increment prompt counter
    const promptNumber = store.incrementPromptCounter(sessionDbId);

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
    store.saveUserPrompt(claudeSessionId, promptNumber, cleanedPrompt);

    logger.info('SESSION', 'Session initialized via HTTP', {
      sessionId: sessionDbId,
      promptNumber,
      project
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false
    });
  });

  /**
   * Handle session waiting for user input (summary-hook calls this when question detected)
   * POST /api/sessions/waiting
   * Body: { claudeSessionId, project, cwd, question, fullMessage, transcriptPath }
   *
   * Creates a waiting session record and triggers Slack notification if enabled
   */
  private handleSessionWaiting = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { claudeSessionId, project, cwd, question, fullMessage, transcriptPath } = req.body;

    if (!claudeSessionId || !project || !cwd) {
      return this.badRequest(res, 'Missing required fields: claudeSessionId, project, cwd');
    }

    logger.info('SESSION', 'Session waiting for user input', {
      claudeSessionId: claudeSessionId.substring(0, 8) + '...',
      project,
      hasQuestion: !!question,
    });

    // Get notification manager from worker service
    const notificationManager = this.workerService.getNotificationManager?.();

    if (!notificationManager || !notificationManager.isEnabled()) {
      // Slack notifications not enabled - just log and return
      logger.debug('SESSION', 'Slack notifications not enabled, skipping waiting notification');
      res.json({ status: 'skipped', reason: 'notifications_disabled' });
      return;
    }

    try {
      const waitingSessionId = await notificationManager.notifyWaitingForInput(
        claudeSessionId,
        project,
        cwd,
        question || null,
        fullMessage || '',
        transcriptPath || null
      );

      if (waitingSessionId) {
        logger.success('SESSION', 'Created waiting session with notification', {
          waitingSessionId,
          project,
        });

        res.json({
          status: 'notified',
          waitingSessionId,
        });
      } else {
        res.json({ status: 'skipped', reason: 'notification_failed' });
      }
    } catch (error: any) {
      logger.error('SESSION', 'Failed to create waiting session', {
        claudeSessionId,
        project,
      }, error);

      res.status(500).json({
        status: 'error',
        error: error.message,
      });
    }
  });

  /**
   * Respond to a waiting session from local client (Claude Code / VS Code)
   * POST /api/sessions/waiting/:id/respond
   * Body: { response, source?: 'local' | 'api' }
   *
   * This allows responding from Claude Code or VS Code instead of Slack
   */
  private handleWaitingSessionRespond = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const waitingSessionId = this.parseIntParam(req, res, 'id');
    if (waitingSessionId === null) return;

    const { response, source = 'local' } = req.body;

    if (!response) {
      return this.badRequest(res, 'Missing required field: response');
    }

    const store = this.dbManager.getSessionStore();
    const waitingSession = store.getWaitingSessionById(waitingSessionId);

    if (!waitingSession) {
      res.status(404).json({
        status: 'error',
        error: 'Waiting session not found',
      });
      return;
    }

    if (waitingSession.status !== 'waiting') {
      res.status(409).json({
        status: 'error',
        error: `Session is already ${waitingSession.status}`,
        respondedAt: waitingSession.responded_at,
        responseSource: waitingSession.response_source,
      });
      return;
    }

    // Check interaction mode - if slack-only, don't allow local responses
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const interactionMode = settings.CLAUDE_MEM_INTERACTION_MODE || 'auto';

    if (interactionMode === 'slack-only') {
      res.status(403).json({
        status: 'error',
        error: 'Local responses are disabled. Interaction mode is set to slack-only.',
      });
      return;
    }

    try {
      // Mark session as responded (from local)
      const responseSource = source === 'api' ? 'api' : 'local';
      store.markWaitingSessionResponded(waitingSessionId, response, responseSource);

      logger.success('SESSION', 'Waiting session responded via local', {
        waitingSessionId,
        claudeSessionId: waitingSession.claude_session_id.substring(0, 8) + '...',
        project: waitingSession.project,
        responseSource,
      });

      // Notify Slack thread that session was continued from local (if Slack was involved)
      if (waitingSession.slack_thread_ts && waitingSession.slack_channel_id) {
        const notificationManager = this.workerService.getNotificationManager?.();
        if (notificationManager && notificationManager.isEnabled()) {
          // Get SlackService to send update
          await notificationManager.notifyRespondedFromLocal(
            waitingSession.slack_channel_id,
            waitingSession.slack_thread_ts,
            responseSource,
            response
          );
        }
      }

      // Continue the Claude Code session
      const notificationManager = this.workerService.getNotificationManager?.();
      if (notificationManager) {
        await notificationManager.continueSession(
          waitingSession.claude_session_id,
          response,
          waitingSession.cwd
        );
      }

      res.json({
        status: 'responded',
        waitingSessionId,
        responseSource,
      });
    } catch (error: any) {
      logger.error('SESSION', 'Failed to respond to waiting session', {
        waitingSessionId,
      }, error);

      res.status(500).json({
        status: 'error',
        error: error.message,
      });
    }
  });

  /**
   * Get all pending waiting sessions
   * GET /api/sessions/waiting
   * Query: ?project=<project-name> (optional filter)
   *
   * Returns all sessions currently waiting for user response
   */
  private handleGetWaitingSessions = this.wrapHandler((req: Request, res: Response): void => {
    const { project } = req.query;

    const store = this.dbManager.getSessionStore();
    let sessions = store.getPendingWaitingSessions();

    // Filter by project if specified
    if (project && typeof project === 'string') {
      sessions = sessions.filter(s => s.project === project);
    }

    res.json({
      count: sessions.length,
      sessions: sessions.map(s => ({
        id: s.id,
        claudeSessionId: s.claude_session_id,
        project: s.project,
        question: s.question,
        createdAt: s.created_at,
        expiresAt: new Date(s.expires_at_epoch).toISOString(),
        hasSlackThread: !!s.slack_thread_ts,
      })),
    });
  });

  /**
   * Share a session summary to Slack
   * POST /api/slack/share/summary
   * Body: { sessionId } - The SDK session ID to share summary for
   */
  private handleShareSummary = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return this.badRequest(res, 'Missing required field: sessionId');
    }

    const notificationManager = this.workerService.getNotificationManager?.();
    if (!notificationManager || !notificationManager.isEnabled()) {
      res.status(503).json({
        status: 'error',
        error: 'Slack notifications are not enabled',
      });
      return;
    }

    // Get the session summary from database
    const store = this.dbManager.getSessionStore();
    const summary = store.getLatestSessionSummary(sessionId);

    if (!summary) {
      res.status(404).json({
        status: 'error',
        error: 'No summary found for this session',
      });
      return;
    }

    try {
      const threadTs = await notificationManager.shareSessionSummary({
        project: summary.project,
        sessionId: summary.sdk_session_id,
        request: summary.request,
        completed: summary.completed,
        learned: summary.learned,
        nextSteps: summary.next_steps,
      });

      if (threadTs) {
        res.json({
          status: 'shared',
          threadTs,
        });
      } else {
        res.json({
          status: 'skipped',
          reason: 'Summary sharing is disabled or Slack not configured',
        });
      }
    } catch (error: any) {
      logger.error('SESSION', 'Failed to share summary to Slack', { sessionId }, error);
      res.status(500).json({
        status: 'error',
        error: error.message,
      });
    }
  });

  /**
   * Share an observation to Slack
   * POST /api/slack/share/observation/:id
   */
  private handleShareObservation = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const observationId = this.parseIntParam(req, res, 'id');
    if (observationId === null) return;

    const notificationManager = this.workerService.getNotificationManager?.();
    if (!notificationManager || !notificationManager.isEnabled()) {
      res.status(503).json({
        status: 'error',
        error: 'Slack notifications are not enabled',
      });
      return;
    }

    // Get the observation from database
    const store = this.dbManager.getSessionStore();
    const observation = store.getObservationById(observationId);

    if (!observation) {
      res.status(404).json({
        status: 'error',
        error: 'Observation not found',
      });
      return;
    }

    try {
      const threadTs = await notificationManager.shareObservation({
        id: observation.id,
        project: observation.project,
        type: observation.type,
        title: observation.title || 'Untitled',
        narrative: observation.text || '',
        files: observation.source_files ? observation.source_files.split(',') : [],
      });

      if (threadTs) {
        res.json({
          status: 'shared',
          threadTs,
          observationId,
        });
      } else {
        res.json({
          status: 'skipped',
          reason: 'Observation type not configured for sharing or Slack not configured',
        });
      }
    } catch (error: any) {
      logger.error('SESSION', 'Failed to share observation to Slack', { observationId }, error);
      res.status(500).json({
        status: 'error',
        error: error.message,
      });
    }
  });
}
