import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  /**
   * Called when idle timeout occurs - MUST trigger abort to kill subprocess.
   * Without this, the subprocess stays alive as a zombie because just returning
   * from the iterator only closes stdin, it doesn't terminate the process.
   *
   * Cross-platform: AbortController.abort() terminates the subprocess via Node.js
   * spawn's signal option (SIGTERM on Unix, process termination on Windows).
   *
   * Required: This callback is mandatory because the whole purpose of this timeout
   * mechanism is to kill zombie processes. Without it, returning from the iterator
   * doesn't actually terminate the subprocess - the exact problem this fixes.
   */
  onIdleTimeout: () => void;
}

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
   *
   * CRITICAL: Calls onIdleTimeout callback after 3 minutes of inactivity.
   * The callback MUST trigger abortController.abort() to kill the SDK subprocess.
   *
   * Why just returning isn't enough (verified via Codex analysis of SDK internals):
   * 1. Returning from iterator → generator stops yielding
   * 2. SDK's Query.streamInput() closes stdin via transport.endInput()
   * 3. But subprocess may NOT exit on stdin EOF alone
   * 4. Only abort() sends SIGTERM via ProcessTransport abort handler
   * 5. Without SIGTERM, subprocess becomes a zombie
   */
  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout } = options;
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
          const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

          if (!receivedMessage) {
            if (signal.aborted) continue; // Let loop check signal.aborted and exit

            // Final safety check - has a message arrived in the race window?
            // This handles the case where a message is enqueued just as the timeout fires
            const finalCheck = this.store.claimAndDelete(sessionDbId);
            if (finalCheck) {
              lastActivityTime = Date.now();
              yield this.toPendingMessageWithId(finalCheck);
              continue; // Keep processing - don't abort
            }

            // Timeout occurred after 3 minutes of idle time with no final messages
            // Note: idleDuration >= IDLE_TIMEOUT_MS is guaranteed since waitForMessage
            // only returns false after exactly IDLE_TIMEOUT_MS (or abort, handled above)
            const idleDuration = Date.now() - lastActivityTime;
            logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
              sessionDbId,
              idleDurationMs: idleDuration
            });
            // CRITICAL: Call the abort callback to actually kill the subprocess
            // Just returning from the iterator doesn't terminate the Claude process!
            onIdleTimeout();
            return;
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
  private waitForMessage(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
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
