
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

  async finalizeSession(sessionDbId: number): Promise<void> {
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

    // The in-RAM message buffer is dropped when the session is removed
    // (SessionManager.removeSessionImmediate/deleteSession → buffer.dispose),
    // so there is nothing durable to clear here.

    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);

    logger.info('SESSION', 'Session finalized', { sessionId: sessionDbId });
  }

  async completeByDbId(sessionDbId: number): Promise<void> {
    await this.finalizeSession(sessionDbId);

    await this.sessionManager.deleteSession(sessionDbId);
  }
}
