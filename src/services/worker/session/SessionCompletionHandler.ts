
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

  finalizeSession(sessionDbId: number): void {
    const sessionStore = this.dbManager.getSessionStore();

    const row = sessionStore.getSessionById(sessionDbId);
    if (!row) {
      logger.debug('SESSION', 'finalizeSession: session not found, skipping', { sessionId: sessionDbId });
      return;
    }
    if (row.status === 'completed') {
      logger.debug('SESSION', 'finalizeSession: already completed, skipping', { sessionId: sessionDbId });
      return;
    }

    sessionStore.markSessionCompleted(sessionDbId);

    try {
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const cleared = pendingStore.clearPendingForSession(sessionDbId);
      if (cleared > 0) {
        logger.warn('SESSION', `Cleared ${cleared} orphaned pending messages on session finalize`, {
          sessionId: sessionDbId, cleared
        });
      }
    } catch (e) {
      logger.debug('SESSION', 'Failed to clear pending queue on session finalize', {
        sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e)
      });
    }

    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);

    logger.info('SESSION', 'Session finalized', { sessionId: sessionDbId });
  }

  async completeByDbId(sessionDbId: number): Promise<void> {
    this.finalizeSession(sessionDbId);

    await this.sessionManager.deleteSession(sessionDbId);
  }
}
