/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromPrompt } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SDKAgent } from '../../SDKAgent.js';
import type { WorkerService } from '../../../worker-service.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { SessionCompletionHandler } from '../../session/SessionCompletionHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import type { APIError } from '../../worker-types.js';
import {
  broadcastNewPrompt,
  broadcastSessionStarted,
  broadcastObservationQueued,
  broadcastSummarizeQueued
} from '../../events/session-events.js';

export class SessionRoutes {
  private completionHandler: SessionCompletionHandler;

  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService
  ) {
    this.completionHandler = new SessionCompletionHandler(
      sessionManager,
      dbManager,
      sseBroadcaster,
      workerService
    );
  }

  /**
   * Ensures SDK agent generator is running for a session
   * Auto-starts if not already running to process pending queue
   */
  private ensureGeneratorRunning(sessionDbId: number, source: string): void {
    const session = this.sessionManager.getSession(sessionDbId);
    logger.debug('SESSION', `ensureGeneratorRunning called (${source})`, {
      sessionId: sessionDbId,
      sessionExists: !!session,
      hasGenerator: session?.generatorPromise !== null && session?.generatorPromise !== undefined
    });
    if (session && !session.generatorPromise) {
      logger.debug('SESSION', `Generator auto-starting (${source})`, {
        sessionId: sessionDbId
      });

      session.generatorPromise = this.sdkAgent.startSession(session, this.workerService)
        .catch(err => {
          logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
        })
        .finally(() => {
          logger.debug('SESSION', `Generator finished`, { sessionId: sessionDbId });
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
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      if (isNaN(sessionDbId)) {
        res.status(400).json({ error: 'Invalid sessionDbId' });
        return;
      }

    const { userPrompt, promptNumber } = req.body;
    const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = this.dbManager.getSessionStore().getLatestUserPrompt(session.claudeSessionId);

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      broadcastNewPrompt(this.sseBroadcaster, this.workerService, {
        id: latestPrompt.id,
        claude_session_id: latestPrompt.claude_session_id,
        project: latestPrompt.project,
        prompt_number: latestPrompt.prompt_number,
        prompt_text: latestPrompt.prompt_text,
        created_at_epoch: latestPrompt.created_at_epoch
      });

      // Sync user prompt to Chroma with error logging
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
      }).catch(err => {
        logger.error('CHROMA', 'Failed to sync user_prompt', {
          promptId: latestPrompt.id,
          sessionId: sessionDbId
        }, err);
      });
    }

    // Ensure SDK agent is running to process any queued messages
    // Use single entry point for generator management (no manual starts)
    this.ensureGeneratorRunning(sessionDbId, 'init');

    // Broadcast session started event
    broadcastSessionStarted(this.sseBroadcaster, this.workerService, sessionDbId, session.project);

      res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
    } catch (error) {
      logger.failure('WORKER', 'Request failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  };

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
    broadcastObservationQueued(this.sseBroadcaster, this.workerService, sessionDbId);

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
    broadcastSummarizeQueued(this.workerService);

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

    const queueLength = this.sessionManager.getPendingMessageStore().getPendingCount(sessionDbId);

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
   * Queue observations by claudeSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { claudeSessionId, tool_name, tool_input, tool_response, cwd }
   *
   * IMPORTANT: Privacy tags are stripped at the hook layer (edge processing).
   * The worker receives pre-sanitized data and assumes tags have been removed.
   * tool_input and tool_response arrive as strings from the hook.
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

    // Parse tool_input once at worker entry (normalize ANY -> string)
    let parsedToolInput: any;
    try {
      // If it's already a string, parse it; otherwise use it directly
      parsedToolInput = typeof tool_input === 'string' ? JSON.parse(tool_input) : tool_input;
    } catch (error) {
      logger.debug('SESSION', 'Failed to parse tool_input', { tool_name }, error);
      parsedToolInput = {};
    }

    // Skip meta-observations: file operations on session-memory files
    const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
    if (fileOperationTools.has(tool_name) && parsedToolInput) {
      const filePath = parsedToolInput.file_path || parsedToolInput.notebook_path;
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

    // Get existing session (must have been initialized via /api/sessions/init)
    const sessionDbId = store.getSessionDbIdByClaudeId(claudeSessionId);
    if (!sessionDbId) {
      return this.badRequest(res, 'Session not initialized. /api/sessions/init must be called first.');
    }

    // Get prompt number from active session (avoids race with DB counter)
    // Session stores lastPromptNumber set during init, eliminating DB read
    const session = this.sessionManager.getSession(sessionDbId);
    const promptNumber = session?.lastPromptNumber || store.getPromptCounter(sessionDbId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = store.getUserPrompt(claudeSessionId, promptNumber);
    if (!userPrompt || userPrompt.trim() === '') {
      logger.debug('HOOK', 'Skipping observation - user prompt was entirely private', {
        sessionId: sessionDbId,
        promptNumber,
        tool_name
      });
      res.json({ status: 'skipped', reason: 'private' });
      return;
    }

    // Data arrives pre-sanitized from hook (privacy tags already stripped)
    // Defensive validation: ensure we have valid strings
    const finalToolInput = tool_input || '{}';
    const finalToolResponse = tool_response || '{}';

    // Queue observation (tool_input and tool_response are strings from hook)
    this.sessionManager.queueObservation(sessionDbId, {
      tool_name,
      tool_input: finalToolInput,
      tool_response: finalToolResponse,
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
    broadcastObservationQueued(this.sseBroadcaster, this.workerService, sessionDbId);

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

    // Get existing session (must have been initialized via /api/sessions/init)
    const sessionDbId = store.getSessionDbIdByClaudeId(claudeSessionId);
    if (!sessionDbId) {
      return this.badRequest(res, 'Session not initialized. /api/sessions/init must be called first.');
    }

    // Get prompt number from active session (avoids race with DB counter)
    // Session stores lastPromptNumber set during init, eliminating DB read
    const session = this.sessionManager.getSession(sessionDbId);
    const promptNumber = session?.lastPromptNumber || store.getPromptCounter(sessionDbId);

    // Privacy check: skip if user prompt was entirely private
    const userPrompt = store.getUserPrompt(claudeSessionId, promptNumber);
    if (!userPrompt || userPrompt.trim() === '') {
      logger.debug('HOOK', 'Skipping summarize - user prompt was entirely private', {
        sessionId: sessionDbId,
        promptNumber
      });
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
    broadcastSummarizeQueued(this.workerService);

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
   * Body: { claudeSessionId, project, prompt, mode? }
   *
   * Performs all session initialization DB operations:
   * - Creates/gets SDK session (idempotent)
   * - Stores mode in session metadata (if provided)
   * - Increments prompt counter
   * - Saves user prompt (with privacy tag stripping)
   *
   * Returns: { sessionDbId, promptNumber, skipped: boolean, reason?: string }
   */
  private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
    const { claudeSessionId, project, prompt, mode } = req.body;

    // Validate required parameters
    if (!this.validateRequired(req, res, ['claudeSessionId', 'project', 'prompt'])) {
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Step 1: Create/get SDK session (idempotent INSERT OR IGNORE)
    const sessionDbId = store.createSDKSession(claudeSessionId, project, prompt);

    // Step 2: Store mode in session metadata (if provided)
    if (mode) {
      store.setSessionMode(sessionDbId, mode);
    }

    // Step 3: Increment prompt counter
    const promptNumber = store.incrementPromptCounter(sessionDbId);

    // Step 4: Strip privacy tags from prompt
    const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

    // Step 5: Check if prompt is entirely private
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

    // Step 6: Save cleaned user prompt
    store.saveUserPrompt(claudeSessionId, promptNumber, cleanedPrompt);

    logger.info('SESSION', 'Session initialized via HTTP', {
      sessionId: sessionDbId,
      promptNumber,
      project,
      mode: mode || 'code'
    });

    res.json({
      sessionDbId,
      promptNumber,
      skipped: false
    });
  });
}
