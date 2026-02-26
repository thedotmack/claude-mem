/**
 * SummaryQueueService
 *
 * Encapsulates the "queue summary + broadcast" sequence, reusable by both
 * SessionRoutes (Stop hook flow) and ActiveSessionRoutes (UI close flow).
 */

import type { SessionManager } from '../SessionManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { logger } from '../../../utils/logger.js';

export interface SummaryQueueDeps {
  readonly sessionManager: Pick<SessionManager, 'queueSummarize'>;
  readonly eventBroadcaster: Pick<SessionEventBroadcaster, 'broadcastSummarizeQueued'>;
}

export class SummaryQueueService {
  constructor(private readonly deps: SummaryQueueDeps) {}

  /**
   * Queue a summary and broadcast the event.
   * Returns true if queued successfully, false on failure.
   * Broadcast is best-effort and does not affect the return value.
   */
  queueSummary(sessionDbId: number, lastAssistantMessage?: string): boolean {
    try {
      this.deps.sessionManager.queueSummarize(sessionDbId, lastAssistantMessage);
    } catch (error) {
      logger.error('SESSION', 'Failed to queue summary', { sessionId: sessionDbId }, error);
      return false;
    }

    try {
      this.deps.eventBroadcaster.broadcastSummarizeQueued();
    } catch (error) {
      logger.error('SESSION', 'Failed to broadcast summary queued event', { sessionId: sessionDbId }, error);
    }

    logger.info('SESSION', 'Summary queued', { sessionId: sessionDbId, hasContext: !!lastAssistantMessage });
    return true;
  }
}
