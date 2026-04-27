/**
 * ObservationBroadcaster: SSE broadcasting for observations and summaries
 *
 * Responsibility:
 * - Broadcast new observations to SSE clients
 * - Broadcast new summaries to SSE clients
 * - Handle worker reference safely (null checks)
 *
 * BUGFIX: This module fixes the incorrect field names in ClaudeProvider:
 * - ClaudeProvider used `obs.files` which doesn't exist - should be `obs.files_read`
 * - ClaudeProvider used hardcoded `files_modified: JSON.stringify([])` - should use `obs.files_modified`
 */

import type { WorkerRef, ObservationSSEPayload, SummarySSEPayload } from './types.js';
import { logger } from '../../../utils/logger.js';
import { shouldEmitProjectRow } from '../../../shared/should-track-project.js';

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

  // Parity with PaginationHelper's unfiltered-list SQL filter (#2118):
  // observer-session rows are internal and must not stream to viewer clients.
  // Same predicate used by both filters via shouldEmitProjectRow so they
  // can never drift apart.
  if (!shouldEmitProjectRow(payload.project)) {
    logger.debug('WORKER', 'SSE observation broadcast skipped (internal project)', {
      project: payload.project,
      id: payload.id,
    });
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

  // Parity with PaginationHelper's unfiltered-list SQL filter (#2118).
  if (!shouldEmitProjectRow(payload.project)) {
    logger.debug('WORKER', 'SSE summary broadcast skipped (internal project)', {
      project: payload.project,
      id: payload.id,
    });
    return;
  }

  worker.sseBroadcaster.broadcast({
    type: 'new_summary',
    summary: payload
  });
}
