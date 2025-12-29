import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic database claiming to prevent race conditions.
   * Waits for 'message' event when queue is empty.
   */
  async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
    while (!signal.aborted) {
      try {
        // 1. Atomically claim next message from DB
        const persistentMessage = this.store.claimNextMessage(sessionDbId);

        if (persistentMessage) {
          // Yield the message for processing
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // 2. Queue empty - wait for wake-up event
          // We use a promise that resolves on 'message' event or abort
          await this.waitForMessage(signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  private waitForMessage(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const onMessage = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        resolve(); // Resolve to let the loop check signal.aborted and exit
      };

      const cleanup = () => {
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
