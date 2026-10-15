// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';

/** The most response bytes waiting for capture observers before the capture is marked cut (plan Phase 2 task 5). */
export const CAPTURE_SPOOL_CAP_BYTES = 8 * 1024 * 1024;

type QueuedCaptureItem = { kind: 'chunk'; chunk: Uint8Array } | { kind: 'callback'; callback: () => void };

/**
 * Hands copies of relayed chunks to capture observers off the client's path.
 * offer() never blocks and never throws: delivery runs on a later macrotask,
 * and past the byte cap the queue stops taking chunks and reports overflow
 * (the capture is cut, the client is never slowed).
 */
export class BoundedCaptureQueue {
  private readonly items: QueuedCaptureItem[] = [];
  private queuedChunkBytes = 0;
  private overflowed = false;
  private drainScheduled = false;

  constructor(
    private readonly capBytes: number,
    private readonly deliverChunk: (chunk: Uint8Array) => void,
  ) {}

  get hasOverflowed(): boolean {
    return this.overflowed;
  }

  offer(chunk: Uint8Array): void {
    if (this.overflowed) return;
    if (this.queuedChunkBytes + chunk.byteLength > this.capBytes) {
      this.overflowed = true;
      return;
    }
    // A copy: the original chunk belongs to the client's stream.
    this.items.push({ kind: 'chunk', chunk: chunk.slice() });
    this.queuedChunkBytes += chunk.byteLength;
    this.scheduleDrain();
  }

  /** Runs callback after every chunk offered so far has been delivered. */
  afterDelivered(callback: () => void): void {
    this.items.push({ kind: 'callback', callback });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.drainScheduled = false;
    for (let item = this.items.shift(); item; item = this.items.shift()) {
      try {
        if (item.kind === 'chunk') {
          this.queuedChunkBytes -= item.chunk.byteLength;
          this.deliverChunk(item.chunk);
        } else {
          item.callback();
        }
      } catch (error) {
        // An observer's failure is never the relay's.
        logger.error('WIRE', 'Capture observer failed', {}, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
