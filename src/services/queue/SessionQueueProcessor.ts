import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic claim-and-delete to prevent duplicates.
   * The queue is a pure buffer: claim it, delete it, process in memory.
   * Waits for 'message' event when queue is empty.
   * Exits gracefully after idle timeout to prevent zombie observer processes.
   */
  async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      try {
        // Atomically claim AND DELETE next message from DB
        // Message is now in memory only - no "processing" state tracking needed
        const persistentMessage = this.store.claimAndDelete(sessionDbId);

        if (persistentMessage) {
          // Reset activity time when we successfully yield a message
          lastActivityTime = Date.now();
          // Yield the message for processing (it's already deleted from queue)
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // Queue empty - wait for wake-up event or timeout
          logger.debug('SESSION', 'Queue empty, waiting for message with idle timeout', { sessionDbId, timeoutMs: IDLE_TIMEOUT_MS });
          const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

          if (!receivedMessage && !signal.aborted) {
            // Timeout occurred - check if we've been idle too long
            const idleDuration = Date.now() - lastActivityTime;
            if (idleDuration >= IDLE_TIMEOUT_MS) {
              logger.info('SESSION', 'Exiting queue iterator due to idle timeout', { sessionDbId, idleDurationMs: idleDuration });
              return; // Exit gracefully
            }
          }
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

  /**
   * Wait for a message event or timeout.
   * @param signal - AbortSignal to cancel waiting
   * @param timeoutMs - Maximum time to wait before returning
   * @returns true if a message was received, false if timeout occurred
   */
  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); // Message received
      };

      const onAbort = () => {
        cleanup();
        resolve(false); // Aborted, let loop check signal.aborted
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); // Timeout occurred
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }
}
