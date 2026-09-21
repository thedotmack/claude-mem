import type { SSEBroadcaster } from '../SSEBroadcaster.js';
import { RateLimitTracker } from './RateLimitTracker.js';
import type { GeminiRateLimitsStatus } from './types.js';

export class GeminiStatusBroadcaster {
  private static instance: GeminiStatusBroadcaster | null = null;
  private sseBroadcaster: SSEBroadcaster | null = null;

  private constructor() {
    const tracker = RateLimitTracker.getInstance();
    tracker.setStatusChangeHandler((status: GeminiRateLimitsStatus) => {
      this.broadcastStatus(status);
    });
  }

  public static getInstance(): GeminiStatusBroadcaster {
    if (!GeminiStatusBroadcaster.instance) {
      GeminiStatusBroadcaster.instance = new GeminiStatusBroadcaster();
    }
    return GeminiStatusBroadcaster.instance;
  }

  public setSSEBroadcaster(broadcaster: SSEBroadcaster): void {
    this.sseBroadcaster = broadcaster;
  }

  public broadcastStatus(status: GeminiRateLimitsStatus): void {
    if (!this.sseBroadcaster) return;

    this.sseBroadcaster.broadcast({
      type: 'gemini_status_update',
      data: status,
      timestamp: Date.now(),
    });
  }

  public broadcastModelSwitched(fromModel: string, toModel: string, reason: string): void {
    if (!this.sseBroadcaster) return;

    this.sseBroadcaster.broadcast({
      type: 'gemini_model_switched',
      data: {
        fromModel,
        toModel,
        reason,
        timestamp: Date.now(),
      },
    });
  }

  public broadcastQueuePaused(waitSeconds: number, reason: string): void {
    if (!this.sseBroadcaster) return;

    this.sseBroadcaster.broadcast({
      type: 'gemini_queue_paused',
      data: {
        waitSeconds,
        reason,
        timestamp: Date.now(),
      },
    });
  }

  public broadcastQueueResumed(): void {
    if (!this.sseBroadcaster) return;

    this.sseBroadcaster.broadcast({
      type: 'gemini_queue_resumed',
      data: {
        timestamp: Date.now(),
      },
    });
  }
}
