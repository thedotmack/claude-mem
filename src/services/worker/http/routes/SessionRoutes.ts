/**
 * Session Routes
 *
 * Handles session lifecycle operations: initialization, observations, summarization, completion.
 * These routes manage the flow of work through the Claude Agent SDK.
 */

import express, { Request, Response } from 'express';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { logger } from '../../../../utils/logger.js';
import { stripMemoryTagsFromJson } from '../../../../utils/tag-stripping.js';
import { SessionManager } from '../../SessionManager.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SDKAgent } from '../../SDKAgent.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';

export class SessionRoutes {
  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private sdkAgent: SDKAgent,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService
  ) {}

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
        .catch(err => {
          logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
        })
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
    app.post('/api/sessions/observations', this.handleObservationsByClaudeId.bind(this));
    app.post('/api/sessions/summarize', this.handleSummarizeByClaudeId.bind(this));
    app.post('/api/sessions/complete', this.handleSessionCompleteByClaudeId.bind(this));
  }

  /**
   * Initialize a new session
   */
  private handleSessionInit(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const { userPrompt, promptNumber } = req.body;
      const session = this.sessionManager.initializeSession(sessionDbId, userPrompt, promptNumber);

      // Get the latest user_prompt for this session to sync to Chroma
      const latestPrompt = this.dbManager.getSessionStore().getLatestUserPrompt(session.claudeSessionId);

      // Broadcast new prompt to SSE clients (for web UI)
      if (latestPrompt) {
        this.sseBroadcaster.broadcast({
          type: 'new_prompt',
          prompt: {
            id: latestPrompt.id,
            claude_session_id: latestPrompt.claude_session_id,
            project: latestPrompt.project,
            prompt_number: latestPrompt.prompt_number,
            prompt_text: latestPrompt.prompt_text,
            created_at_epoch: latestPrompt.created_at_epoch
          }
        });

        // Start activity indicator immediately when prompt arrives (work is about to begin)
        this.sseBroadcaster.broadcast({
          type: 'processing_status',
          isProcessing: true
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

      // Broadcast processing status (based on queue depth)
      this.workerService.broadcastProcessingStatus();

      // Start SDK agent in background (pass worker ref for spinner control)
      logger.info('SESSION', 'Generator starting', {
        sessionId: sessionDbId,
        project: session.project,
        promptNum: session.lastPromptNumber
      });

      session.generatorPromise = this.sdkAgent.startSession(session, this.workerService)
        .catch(err => {
          logger.failure('SDK', 'SDK agent error', { sessionId: sessionDbId }, err);
        })
        .finally(() => {
          // Clear generator reference when completed
          logger.info('SESSION', `Generator finished`, { sessionId: sessionDbId });
          session.generatorPromise = null;
          // Broadcast status change (generator finished, may stop spinner)
          this.workerService.broadcastProcessingStatus();
        });

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_started',
        sessionDbId,
        project: session.project
      });

      res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
    } catch (error) {
      logger.failure('WORKER', 'Session init failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Queue observations for processing
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleObservations(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
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

      // Broadcast activity status (queue depth changed)
      this.workerService.broadcastProcessingStatus();

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'observation_queued',
        sessionDbId
      });

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Observation queuing failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Queue summarize request
   * CRITICAL: Ensures SDK agent is running to process the queue (ALWAYS SAVE EVERYTHING)
   */
  private handleSummarize(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const { last_user_message, last_assistant_message } = req.body;

      this.sessionManager.queueSummarize(sessionDbId, last_user_message, last_assistant_message);

      // CRITICAL: Ensure SDK agent is running to consume the queue
      this.ensureGeneratorRunning(sessionDbId, 'summarize');

      // Broadcast activity status (queue depth changed)
      this.workerService.broadcastProcessingStatus();

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Summarize queuing failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get session status
   */
  private handleSessionStatus(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
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
    } catch (error) {
      logger.failure('WORKER', 'Session status failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Delete a session
   */
  private async handleSessionDelete(req: Request, res: Response): Promise<void> {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      await this.sessionManager.deleteSession(sessionDbId);

      // Mark session complete in database
      this.dbManager.markSessionComplete(sessionDbId);

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_completed',
        sessionDbId
      });

      res.json({ status: 'deleted' });
    } catch (error) {
      logger.failure('WORKER', 'Session delete failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Complete a session (backward compatibility for cleanup-hook)
   * cleanup-hook expects POST /sessions/:sessionDbId/complete instead of DELETE
   */
  private async handleSessionComplete(req: Request, res: Response): Promise<void> {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      if (isNaN(sessionDbId)) {
        res.status(400).json({ success: false, error: 'Invalid session ID' });
        return;
      }

      await this.sessionManager.deleteSession(sessionDbId);

      // Mark session complete in database
      this.dbManager.markSessionComplete(sessionDbId);

      // Broadcast processing status (based on queue depth)
      this.workerService.broadcastProcessingStatus();

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_completed',
        timestamp: Date.now(),
        sessionDbId
      });

      res.json({ success: true });
    } catch (error) {
      logger.failure('WORKER', 'Session complete failed', {}, error as Error);
      res.status(500).json({ success: false, error: String(error) });
    }
  }

  /**
   * Queue observations by claudeSessionId (post-tool-use-hook uses this)
   * POST /api/sessions/observations
   * Body: { claudeSessionId, tool_name, tool_input, tool_response, cwd }
   */
  private handleObservationsByClaudeId(req: Request, res: Response): void {
    try {
      const { claudeSessionId, tool_name, tool_input, tool_response, cwd } = req.body;

      if (!claudeSessionId) {
        res.status(400).json({ error: 'Missing claudeSessionId' });
        return;
      }

      const store = this.dbManager.getSessionStore();

      // Get or create session
      const sessionDbId = store.createSDKSession(claudeSessionId, '', '');
      const promptNumber = store.getPromptCounter(sessionDbId);

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

      // Strip memory tags from tool_input and tool_response
      let cleanedToolInput = '{}';
      let cleanedToolResponse = '{}';

      try {
        cleanedToolInput = tool_input !== undefined
          ? stripMemoryTagsFromJson(JSON.stringify(tool_input))
          : '{}';
      } catch (error) {
        cleanedToolInput = '{"error": "Failed to serialize tool_input"}';
      }

      try {
        cleanedToolResponse = tool_response !== undefined
          ? stripMemoryTagsFromJson(JSON.stringify(tool_response))
          : '{}';
      } catch (error) {
        cleanedToolResponse = '{"error": "Failed to serialize tool_response"}';
      }

      // Queue observation
      this.sessionManager.queueObservation(sessionDbId, {
        tool_name,
        tool_input: cleanedToolInput,
        tool_response: cleanedToolResponse,
        prompt_number: promptNumber,
        cwd: cwd || ''
      });

      // Ensure SDK agent is running
      this.ensureGeneratorRunning(sessionDbId, 'observation');

      // Broadcast activity status
      this.workerService.broadcastProcessingStatus();

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'observation_queued',
        sessionDbId
      });

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Observation by claudeId failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Queue summarize by claudeSessionId (summary-hook uses this)
   * POST /api/sessions/summarize
   * Body: { claudeSessionId, last_user_message, last_assistant_message }
   *
   * Checks privacy, queues summarize request for SDK agent
   */
  private handleSummarizeByClaudeId(req: Request, res: Response): void {
    try {
      const { claudeSessionId, last_user_message, last_assistant_message } = req.body;

      if (!claudeSessionId) {
        res.status(400).json({ error: 'Missing claudeSessionId' });
        return;
      }

      const store = this.dbManager.getSessionStore();

      // Get or create session
      const sessionDbId = store.createSDKSession(claudeSessionId, '', '');
      const promptNumber = store.getPromptCounter(sessionDbId);

      // Privacy check: skip if user prompt was entirely private
      const userPrompt = store.getUserPrompt(claudeSessionId, promptNumber);
      if (!userPrompt || userPrompt.trim() === '') {
        logger.debug('HOOK', 'Skipping summary - user prompt was entirely private', {
          sessionId: sessionDbId,
          promptNumber
        });
        res.json({ status: 'skipped', reason: 'private' });
        return;
      }

      // Queue summarize
      this.sessionManager.queueSummarize(sessionDbId, last_user_message || '', last_assistant_message);

      // Ensure SDK agent is running
      this.ensureGeneratorRunning(sessionDbId, 'summarize');

      // Broadcast activity status
      this.workerService.broadcastProcessingStatus();

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('WORKER', 'Summarize by claudeId failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Complete session by claudeSessionId (cleanup-hook uses this)
   * POST /api/sessions/complete
   * Body: { claudeSessionId }
   *
   * Marks session complete, stops SDK agent, broadcasts status
   */
  private async handleSessionCompleteByClaudeId(req: Request, res: Response): Promise<void> {
    try {
      const { claudeSessionId } = req.body;

      if (!claudeSessionId) {
        res.status(400).json({ success: false, error: 'Missing claudeSessionId' });
        return;
      }

      const store = this.dbManager.getSessionStore();

      // Find session by claudeSessionId
      const session = store.findActiveSDKSession(claudeSessionId);
      if (!session) {
        // No active session - nothing to clean up (may have already been completed)
        res.json({ success: true, message: 'No active session found' });
        return;
      }

      const sessionDbId = session.id;

      // Delete from session manager (aborts SDK agent)
      await this.sessionManager.deleteSession(sessionDbId);

      // Mark session complete in database
      this.dbManager.markSessionComplete(sessionDbId);

      // Broadcast processing status
      this.workerService.broadcastProcessingStatus();

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_completed',
        timestamp: Date.now(),
        sessionDbId
      });

      res.json({ success: true });
    } catch (error) {
      logger.failure('WORKER', 'Session complete by claudeId failed', {}, error as Error);
      res.status(500).json({ success: false, error: String(error) });
    }
  }
}
