/**
 * Session Completion Handler
 *
 * Consolidates session completion logic for manual session deletion/completion.
 * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete endpoints.
 *
 * Completion flow:
 * - If no pending work: delete session immediately (aborts SDK agent, cleans up)
 * - If pending work (e.g. in-flight summarize): defer deletion up to GRACEFUL_WAIT_MS
 *   to let the generator finish processing, then force-delete.
 *
 * This prevents the Stop hook from needing to poll for summary completion,
 * which previously blocked the CLI for up to 110s per turn.
 * See: https://github.com/thedotmack/claude-mem/issues/1601
 */

import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { logger } from '../../../utils/logger.js';

/** Max time to wait for in-flight work before force-deleting the session. */
const GRACEFUL_WAIT_MS = 15_000;
/** How often to check if the queue has drained. */
const DRAIN_POLL_MS = 500;

export class SessionCompletionHandler {
  private deferredCompletions = new Set<number>();

  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster
  ) {}

  /**
   * Complete session by database ID.
   *
   * If the session has pending messages (e.g. a summarize in flight), defers
   * deletion to let the generator finish. A safety timeout ensures the session
   * is always cleaned up even if the generator stalls.
   *
   * @returns whether completion was deferred (true) or immediate (false).
   */
  async completeByDbId(sessionDbId: number): Promise<{ deferred: boolean }> {
    // Guard: skip if a deferred completion is already scheduled
    if (this.deferredCompletions.has(sessionDbId)) {
      logger.debug('SESSION', 'Deferred completion already scheduled, skipping', { sessionDbId });
      return { deferred: true };
    }

    const pendingStore = this.sessionManager.getPendingMessageStore();
    const queueLength = pendingStore.getPendingCount(sessionDbId);

    if (queueLength === 0) {
      // No pending work — safe to delete immediately
      await this.forceComplete(sessionDbId);
      return { deferred: false };
    }

    // Pending work exists — defer deletion to let the generator drain the queue.
    // This runs in the background so the HTTP response returns immediately.
    logger.info('SESSION', `Deferring session deletion — ${queueLength} message(s) pending`, {
      sessionDbId, queueLength, gracefulWaitMs: GRACEFUL_WAIT_MS
    });
    this.deferredCompletions.add(sessionDbId);

    // Poll until queue drains or timeout
    const deadline = Date.now() + GRACEFUL_WAIT_MS;
    const poll = async () => {
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));

        // Session may have been deleted by another path (e.g. manual delete).
        // Drain any leftover pending messages defensively — the other path's
        // drain may have raced with new enqueues.
        if (!this.sessionManager.getSession(sessionDbId)) {
          this.deferredCompletions.delete(sessionDbId);
          try {
            pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
          } catch { /* best-effort */ }
          return;
        }

        const remaining = pendingStore.getPendingCount(sessionDbId);
        if (remaining === 0) {
          logger.info('SESSION', 'Pending queue drained, completing session', { sessionDbId });
          break;
        }
      }

      this.deferredCompletions.delete(sessionDbId);
      await this.forceComplete(sessionDbId);
    };

    // Fire and forget — don't block the caller
    poll().catch((e) => {
      this.deferredCompletions.delete(sessionDbId);
      logger.warn('SESSION', 'Deferred completion failed, forcing delete', {
        sessionDbId, error: e instanceof Error ? e.message : String(e)
      });
      this.forceComplete(sessionDbId).catch(() => {});
    });

    return { deferred: true };
  }

  /**
   * Immediately delete session and drain orphaned messages.
   */
  private async forceComplete(sessionDbId: number): Promise<void> {
    // Delete from session manager (aborts SDK agent via SIGTERM)
    await this.sessionManager.deleteSession(sessionDbId);

    // Drain orphaned pending messages left by SIGTERM.
    // When deleteSession() aborts the generator, pending messages in the queue
    // are never processed. Without drain, they stay in 'pending' status forever
    // since no future generator will pick them up for a completed session.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const drainedCount = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
      if (drainedCount > 0) {
        logger.warn('SESSION', `Drained ${drainedCount} orphaned pending messages on session completion`, {
          sessionId: sessionDbId, drainedCount
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
