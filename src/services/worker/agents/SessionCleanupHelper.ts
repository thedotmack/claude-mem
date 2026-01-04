/**
 * SessionCleanupHelper: Session state cleanup after response processing
 *
 * Responsibility:
 * - Clear processed message IDs from session
 * - Reset earliest pending timestamp
 * - Clean up old processed messages from persistent store
 * - Broadcast processing status updates
 */

import { logger } from '../../../utils/logger.js';
import type { ActiveSession } from '../../worker-types.js';
import type { PendingMessageStore } from '../../sqlite/PendingMessageStore.js';
import type { WorkerRef } from './types.js';

/**
 * Clean up session state after response processing
 *
 * This function:
 * 1. Clears the set of pending message IDs
 * 2. Resets the earliest pending timestamp
 * 3. Cleans up old processed messages (keeps last 100 for UI display)
 * 4. Broadcasts updated processing status to SSE clients
 *
 * @param session - Active session to clean up
 * @param pendingMessageStore - Store for pending message operations
 * @param worker - Worker reference for status broadcasting (optional)
 */
export function cleanupProcessedMessages(
  session: ActiveSession,
  pendingMessageStore: PendingMessageStore,
  worker: WorkerRef | undefined
): void {
  // Clear the processed message IDs
  session.pendingProcessingIds.clear();
  session.earliestPendingTimestamp = null;

  // Clean up old processed messages (keep last 100 for UI display)
  const deletedCount = pendingMessageStore.cleanupProcessed(100);
  if (deletedCount > 0) {
    logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
  }

  // Broadcast activity status after processing (queue may have changed)
  if (worker && typeof worker.broadcastProcessingStatus === 'function') {
    worker.broadcastProcessingStatus();
  }
}

/**
 * Reset stuck processing messages before fallback
 * Used when Gemini/OpenRouter fails and we need to retry with Claude
 *
 * @param pendingMessageStore - Store for pending message operations
 * @param sessionDbId - Session ID for logging
 * @returns Number of messages reset
 */
export function resetStuckMessagesForFallback(
  pendingMessageStore: PendingMessageStore,
  sessionDbId: number
): number {
  // Reset ALL processing messages (0 = no timeout, reset immediately)
  const resetCount = pendingMessageStore.resetStuckMessages(0);

  if (resetCount > 0) {
    logger.info('SDK', 'Reset processing messages for fallback', {
      sessionDbId,
      resetCount
    });
  }

  return resetCount;
}
