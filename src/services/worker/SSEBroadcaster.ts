
import type { Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { SSEEvent, SSEClient } from '../worker-types.js';

// SSE is a live feed, not a durable queue. Disconnect a stalled consumer
// rather than retaining an unbounded history; EventSource can reconnect.
// Why 1 MiB: the largest frames this broadcaster sends are a single
// new_observation and initial_load (the project catalog). Measured on a
// 3 GB database (223,722 observations, 743 projects) on 2026-11-05, the
// largest observation's text fields total about 48 K characters and the
// catalog's project names about 41 K, so 1 MiB holds roughly 20 of the largest
// frames before a consumer that stopped reading is cut off. A frame
// larger than the whole budget is still written when the client is not
// blocked; the cap only applies to frames queued behind backpressure.
const MAX_PENDING_BYTES = 1024 * 1024;

interface ClientQueue {
  blocked: boolean;
  frames: Array<{ data: string; bytes: number }>;
  bytes: number;
  onDrain: () => void;
}

export class SSEBroadcaster {
  private sseClients: Set<SSEClient> = new Set();

  private queues = new Map<SSEClient, ClientQueue>();

  addClient(res: Response): void {
    if (this.sseClients.has(res)) return;
    this.sseClients.add(res);
    const queue: ClientQueue = {
      blocked: false, frames: [], bytes: 0,
      onDrain: () => {
        queue.blocked = false;
        while (this.queues.get(res) === queue && !queue.blocked && queue.frames.length > 0) {
          const frame = queue.frames.shift()!;
          queue.bytes -= frame.bytes;
          this.writeFrame(res, frame.data);
        }
      },
    };
    this.queues.set(res, queue);
    res.on('drain', queue.onDrain);
    logger.debug('WORKER', 'Client connected', { total: this.sseClients.size });

    const socket = res.socket;
    const onClose = () => {
      res.off('close', onClose);
      res.off('error', onError);
      socket?.off('close', onClose);
      this.removeClient(res);
    };
    // Response errors are asynchronous and cannot be caught around write().
    // Keep the listener until close so pending failed writes remain handled.
    const onError = () => this.disconnectFailedClient(res);
    res.on('error', onError);
    res.on('close', onClose);
    // Bun's node:http emits socket close when a streaming client disconnects.
    socket?.on('close', onClose);

    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  removeClient(res: Response): void {
    const queue = this.queues.get(res);
    if (queue) {
      res.off('drain', queue.onDrain);
      queue.frames.length = 0;
      queue.bytes = 0;
      this.queues.delete(res);
    }
    this.sseClients.delete(res);
    logger.debug('WORKER', 'Client disconnected', { total: this.sseClients.size });
  }

  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      logger.debug('WORKER', 'SSE broadcast skipped (no clients)', { eventType: event.type });
      return; 
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    for (const client of this.sseClients) {
      this.writeFrame(client, data);
    }
  }

  getClientCount(): number {
    return this.sseClients.size;
  }

  private writeFrame(res: Response, data: string): void {
    if (res.destroyed || res.writableEnded) {
      this.removeClient(res);
      return;
    }
    const queue = this.queues.get(res);
    if (!queue) return;
    if (queue.blocked) {
      const bytes = Buffer.byteLength(data, 'utf8');
      if (queue.bytes + bytes > MAX_PENDING_BYTES) {
        logger.warn('WORKER', 'SSE client stopped reading; disconnecting it and dropping its queued frames (it can reconnect)', {
          pendingBytes: queue.bytes,
          pendingFrames: queue.frames.length,
          nextFrameBytes: bytes,
          maxPendingBytes: MAX_PENDING_BYTES,
        });
        this.disconnectFailedClient(res);
        return;
      }
      queue.frames.push({ data, bytes });
      queue.bytes += bytes;
      return;
    }
    try {
      // false means this frame was accepted, but no more may be written
      // until drain. Never enqueue it again or it would be delivered twice.
      queue.blocked = !res.write(data);
    } catch (error) {
      this.disconnectFailedClient(res);
      logger.debug('WORKER', 'SSE client write failed', undefined, error instanceof Error ? error : undefined);
    }
  }

  private disconnectFailedClient(res: Response): void {
    this.removeClient(res);
    // A failed stream must close so EventSource can reconnect. Retain the
    // error listener until close to absorb already queued transport failures.
    if (!res.destroyed) res.destroy();
  }

  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    this.writeFrame(res, data);
  }
}
