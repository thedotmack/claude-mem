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
   * Finalize a session's persistent + broadcast state.
   *
   * Idempotent — safe to call twice. The worker calls this from the SDK-agent
   * generator's finally-block (primary path), and the HTTP route
   * POST /api/sessions/complete also calls it as a backward-compat shim.
   * If the session is already marked completed in the DB, this is a no-op.
   *
   * This method intentionally does NOT touch the in-memory SessionManager map.
   * The generator's finally-block handles in-memory removal via
   * `removeSessionImmediate` (which cannot `await` the generator it's running
   * inside); the HTTP route layers `deleteSession` on top for the case where
   * the generator is still running and needs to be aborted.
   */
  finalizeSession(sessionDbId: number): void {
    const sessionStore = this.dbManager.getSessionStore();

    // Idempotency check: if already completed, do nothing.
    const row = sessionStore.getSessionById(sessionDbId);
    if (!row) {
      logger.debug('SESSION', 'finalizeSession: session not found, skipping', { sessionId: sessionDbId });
      return;
    }
    if (row.status === 'completed') {
      logger.debug('SESSION', 'finalizeSession: already completed, skipping', { sessionId: sessionDbId });
      return;
    }

    // Mark completed in DB (primary source of truth for idempotency).
    sessionStore.markSessionCompleted(sessionDbId);

    // Drain orphaned pending messages. This is best-effort — same rationale
    // as the historical completeByDbId path: messages left 'pending' by a
    // completed session would never be picked up again.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const drainedCount = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
      if (drainedCount > 0) {
        logger.warn('SESSION', `Drained ${drainedCount} orphaned pending messages on session finalize`, {
          sessionId: sessionDbId, drainedCount
        });
      }
    } catch (e) {
      logger.debug('SESSION', 'Failed to drain pending queue on session finalize', {
        sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e)
      });
    }

    // Broadcast session completed event (UI spinner, etc.)
    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);

    logger.info('SESSION', 'Session finalized', { sessionId: sessionDbId });
  }

  /**
   * Complete session by database ID
   * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete
   *
   * Calls `finalizeSession` (DB mark + drain + broadcast, idempotent) and then
   * aborts any running SDK agent via `sessionManager.deleteSession`. The
   * HTTP route wraps this so older callers that still POST to
   * /api/sessions/complete keep working even after the worker self-cleans.
   */
  async completeByDbId(sessionDbId: number): Promise<void> {
    // Finalize first so the DB and broadcast state are consistent even if
    // deleteSession hangs on a slow subprocess exit.
    this.finalizeSession(sessionDbId);

    // Abort SDK agent and clean in-memory state. Idempotent: deleteSession
    // early-returns if the session isn't in the active map.
    await this.sessionManager.deleteSession(sessionDbId);
  }
}
