/**
 * Session Completion Handler
 *
 * Consolidates session completion logic to eliminate duplication across
 * three different completion endpoints (DELETE, POST by DB ID, POST by Claude ID).
 *
 * All completion flows follow the same pattern:
 * 1. Delete session from SessionManager (aborts SDK agent)
 * 2. Mark session complete in database
 * 3. Broadcast session completed event
 */

import { SessionManager } from '../SessionManager.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private dbManager: DatabaseManager,
    private eventBroadcaster: SessionEventBroadcaster
  ) {}

  /**
   * Complete session by database ID
   * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete
   */
  async completeByDbId(sessionDbId: number): Promise<void> {
    // Delete from session manager (aborts SDK agent)
    await this.sessionManager.deleteSession(sessionDbId);

    // Mark session complete in database
    this.dbManager.markSessionComplete(sessionDbId);

    // Broadcast session completed event
    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
  }

  /**
   * Complete session by Claude session ID
   * Used by POST /api/sessions/complete (cleanup-hook endpoint)
   *
   * @returns true if session was found and completed, false if no active session found
   */
  async completeByClaudeId(claudeSessionId: string): Promise<boolean> {
    const store = this.dbManager.getSessionStore();

    // Find session by claudeSessionId
    const session = store.findActiveSDKSession(claudeSessionId);
    if (!session) {
      // No active session - nothing to clean up (may have already been completed)
      return false;
    }

    const sessionDbId = session.id;

    // Complete using standard flow
    await this.completeByDbId(sessionDbId);

    return true;
  }
}
