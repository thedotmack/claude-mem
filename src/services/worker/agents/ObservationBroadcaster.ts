/**
 * ObservationBroadcaster: SSE broadcasting for observations and summaries
 *
 * Responsibility:
 * - Broadcast new observations to SSE clients
 * - Broadcast new summaries to SSE clients
 * - Handle worker reference safely (null checks)
 *
 * BUGFIX: This module fixes the incorrect field names in SDKAgent:
 * - SDKAgent used `obs.files` which doesn't exist - should be `obs.files_read`
 * - SDKAgent used hardcoded `files_modified: JSON.stringify([])` - should use `obs.files_modified`
 */

import type { WorkerRef, ObservationSSEPayload, SummarySSEPayload } from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Broadcast a new observation to SSE clients
 *
 * @param worker - Worker reference with SSE broadcaster (can be undefined)
 * @param payload - Observation data to broadcast
 */
export function broadcastObservation(
  worker: WorkerRef | undefined,
  payload: ObservationSSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_observation',
    observation: payload
  });
}

/**
 * Broadcast a new summary to SSE clients
 *
 * @param worker - Worker reference with SSE broadcaster (can be undefined)
 * @param payload - Summary data to broadcast
 */
export function broadcastSummary(
  worker: WorkerRef | undefined,
  payload: SummarySSEPayload
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_summary',
    summary: payload
  });
}

/**
 * Broadcast a cloud storage warning to SSE clients
 * Used when Pro cloud storage fails and data falls back to local SQLite
 *
 * @param worker - Worker reference with SSE broadcaster (can be undefined)
 * @param message - Warning message to display
 * @param details - Additional details about the failure
 */
export function broadcastCloudStorageWarning(
  worker: WorkerRef | undefined,
  message: string,
  details: { sessionId: number; observationCount: number; error?: string }
): void {
  if (!worker?.sseBroadcaster) {
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'cloud_storage_warning',
    warning: {
      message,
      details,
      timestamp: Date.now()
    }
  });

  logger.warn('SSE', 'Broadcasted cloud storage warning to clients', {
    message,
    ...details
  });
}
