/**
 * Session Completion Handler
 *
 * Consolidates session completion logic for manual session deletion/completion.
 * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete endpoints.
 *
 * Completion flow:
 * 1. Delete session from SessionManager (aborts SDK agent, cleans up in-memory state)
 * 2. Broadcast session completed event (updates UI spinner)
 */

import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { logger } from '../../../utils/logger.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
    private dbManager: DatabaseManager
  ) {}

  /**
   * Complete session by database ID
   * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete
   */
  async completeByDbId(sessionDbId: number): Promise<void> {
    // Persist completion to database before in-memory cleanup (fix for #1532)
    this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);

    // Delete from session manager (aborts SDK agent via SIGTERM)
    await this.sessionManager.deleteSession(sessionDbId);

    // Drain orphaned pending messages left by SIGTERM.
    // When deleteSession() aborts the generator, pending messages in the queue
    // are never processed. drainSessionMessages() requeues recoverable messages
    // (retry_count < maxRetries) so processPendingQueues() can recover them on
    // next startup, and permanently fails exhausted ones.
    // Note: this is best-effort — if a generator outlives the 30s SIGTERM timeout
    // (SessionManager.deleteSession), it may enqueue messages after this drain.
    // In practice this race is rare (zero orphans over 23 days, 3400+ observations).
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const { failed, requeued } = pendingStore.drainSessionMessages(sessionDbId);
      if (failed > 0 || requeued > 0) {
        logger.warn('SESSION', `Drained pending messages on session completion`, {
          sessionId: sessionDbId, failed, requeued
        });
      }
    } catch (e) {
      logger.debug('SESSION', 'Failed to drain pending queue on session completion', {
        sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e)
      });
    }

    // Broadcast session completed event
    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
  }
}
