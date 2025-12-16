/**
 * Queue Routes
 *
 * API endpoints for queue monitoring and management:
 * - GET /api/queue - List all queue messages
 * - POST /api/queue/:id/retry - Retry a specific message
 * - POST /api/queue/:id/abort - Abort/delete a specific message
 * - POST /api/queue/retry-all-stuck - Retry all stuck messages
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { PendingMessageStore } from '../../../sqlite/PendingMessageStore.js';
import { SessionManager } from '../../SessionManager.js';
import type { WorkerService } from '../../../worker-service.js';

// Stuck threshold in ms (matches WatchdogService)
const STUCK_THRESHOLD_MS = 150000; // 2.5 minutes

export class QueueRoutes extends BaseRouteHandler {
  constructor(
    private pendingMessageStore: PendingMessageStore,
    private sessionManager: SessionManager,
    private workerService: WorkerService
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/queue', this.handleGetQueue.bind(this));
    app.post('/api/queue/:id/retry', this.handleRetry.bind(this));
    app.post('/api/queue/:id/abort', this.handleAbort.bind(this));
    app.post('/api/queue/retry-all-stuck', this.handleRetryAllStuck.bind(this));
    app.post('/api/queue/session/:sessionId/restart', this.handleForceRestartSession.bind(this));
    app.post('/api/queue/session/:sessionId/recover', this.handleRecoverSession.bind(this));
  }

  /**
   * Get all queue messages with session diagnostics
   * GET /api/queue
   */
  private handleGetQueue = this.wrapHandler((req: Request, res: Response): void => {
    const messages = this.pendingMessageStore.getQueueMessages();
    const stuckCount = this.pendingMessageStore.getStuckCount(STUCK_THRESHOLD_MS);
    const recentlyProcessed = this.pendingMessageStore.getRecentlyProcessed(10, 30);

    // Get session diagnostics
    const sessionDiagnostics = this.sessionManager.getSessionDiagnostics();
    const sessionStatus: Record<number, { hasActiveAgent: boolean }> = {};
    for (const [sessionId, diag] of sessionDiagnostics.entries()) {
      sessionStatus[sessionId] = { hasActiveAgent: diag.hasActiveAgent };
    }

    // Add computed flags to each message
    const now = Date.now();
    const messagesWithStatus = messages.map(msg => {
      const sessionInfo = sessionStatus[msg.session_db_id];
      return {
        ...msg,
        isStuck: msg.status === 'processing' &&
          msg.started_processing_at_epoch !== null &&
          (now - msg.started_processing_at_epoch) > STUCK_THRESHOLD_MS,
        hasActiveAgent: sessionInfo?.hasActiveAgent ?? false
      };
    });

    // Add computed flags to recently processed
    const recentlyProcessedWithStatus = recentlyProcessed.map(msg => ({
      ...msg,
      isStuck: false,
      hasActiveAgent: false
    }));

    res.json({
      messages: messagesWithStatus,
      recentlyProcessed: recentlyProcessedWithStatus,
      stuckCount,
      stuckThresholdMs: STUCK_THRESHOLD_MS,
      sessionStatus
    });
  });

  /**
   * Retry a specific message
   * POST /api/queue/:id/retry
   */
  private handleRetry = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const success = this.pendingMessageStore.retryMessage(id);

    if (success) {
      // Broadcast updated status
      this.workerService.broadcastProcessingStatus();
    }

    res.json({ success, message: success ? 'Message queued for retry' : 'Message not found or not retryable' });
  });

  /**
   * Abort a specific message
   * POST /api/queue/:id/abort
   */
  private handleAbort = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const success = this.pendingMessageStore.abortMessage(id);

    if (success) {
      // Broadcast updated status
      this.workerService.broadcastProcessingStatus();
    }

    res.json({ success });
  });

  /**
   * Retry all stuck messages
   * POST /api/queue/retry-all-stuck
   */
  private handleRetryAllStuck = this.wrapHandler((req: Request, res: Response): void => {
    const count = this.pendingMessageStore.retryAllStuck(STUCK_THRESHOLD_MS);

    if (count > 0) {
      // Broadcast updated status
      this.workerService.broadcastProcessingStatus();
    }

    res.json({ success: true, count });
  });

  /**
   * Force restart a session - aborts agent and resets messages
   * POST /api/queue/session/:sessionId/restart
   */
  private handleForceRestartSession = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionId = this.parseIntParam(req, res, 'sessionId');
    if (sessionId === null) return;

    const result = await this.sessionManager.forceRestartSession(sessionId);

    // Broadcast updated status
    this.workerService.broadcastProcessingStatus();

    res.json({
      success: result.success,
      messagesReset: result.messagesReset,
      message: `Session ${sessionId} restarted, ${result.messagesReset} messages reset to pending`
    });
  });

  /**
   * Recover an orphaned session - initialize and start agent
   * POST /api/queue/session/:sessionId/recover
   */
  private handleRecoverSession = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionId = this.parseIntParam(req, res, 'sessionId');
    if (sessionId === null) return;

    const result = await this.workerService.recoverOrphanedSession(sessionId);

    // Broadcast updated status
    this.workerService.broadcastProcessingStatus();

    res.json({
      success: result.success,
      pendingCount: result.pendingCount,
      messagesReset: result.messagesReset,
      message: result.success
        ? `Session ${sessionId} recovered: ${result.messagesReset} reset, ${result.pendingCount} pending`
        : `Session ${sessionId} has no pending messages to recover`
    });
  });
}
