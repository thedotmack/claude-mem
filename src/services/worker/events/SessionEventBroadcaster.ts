
import { SSEBroadcaster } from '../SSEBroadcaster.js';
import type { WorkerService } from '../../worker-service.js';
import { logger } from '../../../utils/logger.js';

export class SessionEventBroadcaster {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService
  ) {}

  broadcastNewPrompt(prompt: {
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  }): void {
    this.sseBroadcaster.broadcast({
      type: 'new_prompt',
      prompt
    });

    this.workerService.broadcastProcessingStatus();
  }

  broadcastSessionStarted(sessionDbId: number, project: string): void {
    this.sseBroadcaster.broadcast({
      type: 'session_started',
      sessionDbId,
      project
    });

    this.workerService.broadcastProcessingStatus();
  }

  broadcastObservationQueued(sessionDbId: number): void {
    this.sseBroadcaster.broadcast({
      type: 'observation_queued',
      sessionDbId
    });

    this.workerService.broadcastProcessingStatus();
  }

  broadcastSessionCompleted(sessionDbId: number): void {
    this.sseBroadcaster.broadcast({
      type: 'session_completed',
      timestamp: Date.now(),
      sessionDbId
    });

    this.workerService.broadcastProcessingStatus();
  }

  broadcastSummarizeQueued(): void {
    this.workerService.broadcastProcessingStatus();
  }
}
