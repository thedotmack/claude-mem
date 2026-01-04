/**
 * SessionCleanupHelper: Session state cleanup after response processing
 *
 * Responsibility:
 * - Reset earliest pending timestamp
 * - Broadcast processing status updates
 *
 * NOTE: With claim-and-delete queue pattern, messages are deleted on claim,
 * so there's no pendingProcessingIds tracking or processed message cleanup.
 */

import type { ActiveSession } from '../../worker-types.js';
import { logger } from '../../../utils/logger.js';
import type { WorkerRef } from './types.js';

/**
 * Clean up session state after response processing
 *
 * With claim-and-delete queue pattern, this function simply:
 * 1. Resets the earliest pending timestamp
 * 2. Broadcasts updated processing status to SSE clients
 *
 * @param session - Active session to clean up
 * @param worker - Worker reference for status broadcasting (optional)
 */
export function cleanupProcessedMessages(
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  // Reset earliest pending timestamp for next batch
  session.earliestPendingTimestamp = null;

  // Broadcast activity status after processing (queue may have changed)
  if (worker && typeof worker.broadcastProcessingStatus === 'function') {
    worker.broadcastProcessingStatus();
  }
}
