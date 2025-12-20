/**
 * Session Event Broadcasting Utilities
 *
 * Simple helpers for broadcasting session lifecycle events.
 * Just wraps sseBroadcaster.broadcast() and workerService.broadcastProcessingStatus().
 */

import type { SSEBroadcaster } from '../SSEBroadcaster.js';
import type { WorkerService } from '../../worker-service.js';

export function broadcastNewPrompt(
  sseBroadcaster: SSEBroadcaster,
  workerService: WorkerService,
  prompt: {
    id: number;
    claude_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  }
): void {
  sseBroadcaster.broadcast({ type: 'new_prompt', prompt });
  sseBroadcaster.broadcast({ type: 'processing_status', isProcessing: true });
  workerService.broadcastProcessingStatus();
}

export function broadcastSessionStarted(
  sseBroadcaster: SSEBroadcaster,
  workerService: WorkerService,
  sessionDbId: number,
  project: string
): void {
  sseBroadcaster.broadcast({ type: 'session_started', sessionDbId, project });
  workerService.broadcastProcessingStatus();
}

export function broadcastObservationQueued(
  sseBroadcaster: SSEBroadcaster,
  workerService: WorkerService,
  sessionDbId: number
): void {
  sseBroadcaster.broadcast({ type: 'observation_queued', sessionDbId });
  workerService.broadcastProcessingStatus();
}

export function broadcastSessionCompleted(
  sseBroadcaster: SSEBroadcaster,
  workerService: WorkerService,
  sessionDbId: number
): void {
  sseBroadcaster.broadcast({
    type: 'session_completed',
    timestamp: Date.now(),
    sessionDbId
  });
  workerService.broadcastProcessingStatus();
}

export function broadcastSummarizeQueued(
  workerService: WorkerService
): void {
  workerService.broadcastProcessingStatus();
}
