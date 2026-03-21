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

import type { WorkerRef, ObservationSSEPayload, SummarySSEPayload, TokenUsageSSEPayload, AgentErrorSSEPayload, AgentActivitySSEPayload } from './types.js';
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
 * Broadcast token usage event to SSE clients
 */
export function broadcastTokenUsage(
  worker: WorkerRef | undefined,
  payload: TokenUsageSSEPayload
): void {
  if (!worker?.sseBroadcaster) return;
  worker.sseBroadcaster.broadcast({ type: 'token_usage', data: payload });
}

/**
 * Broadcast agent error event to SSE clients
 */
export function broadcastAgentError(
  worker: WorkerRef | undefined,
  payload: AgentErrorSSEPayload
): void {
  if (!worker?.sseBroadcaster) return;
  worker.sseBroadcaster.broadcast({ type: 'agent_error', data: payload });
}

/**
 * Broadcast agent activity status to SSE clients
 */
export function broadcastAgentActivity(
  worker: WorkerRef | undefined,
  payload: AgentActivitySSEPayload
): void {
  if (!worker?.sseBroadcaster) return;
  worker.sseBroadcaster.broadcast({ type: 'agent_activity', data: payload });
}
