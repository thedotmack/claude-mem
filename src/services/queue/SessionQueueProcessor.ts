import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; 

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  onIdleTimeout?: () => void;
}

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      let persistentMessage: PersistentPendingMessage | null = null;
      try {
        persistentMessage = this.store.claimNextMessage(sessionDbId);
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Failed to claim next message; ending iterator', { sessionDbId }, normalizedError);
        return;
      }

      if (persistentMessage) {
        lastActivityTime = Date.now();
        yield this.toPendingMessageWithId(persistentMessage);
        continue;
      }

      try {
        const idleTimedOut = await this.handleWaitPhase(signal, lastActivityTime, sessionDbId, onIdleTimeout);
        if (idleTimedOut) return;
        lastActivityTime = Date.now();
      } catch (error) {
        if (signal.aborted) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('QUEUE', 'Error waiting for message; ending iterator', { sessionDbId }, normalizedError);
        return;
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

  private async handleWaitPhase(
    signal: AbortSignal,
    lastActivityTime: number,
    sessionDbId: number,
    onIdleTimeout?: () => void
  ): Promise<boolean> {
    const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

    if (!receivedMessage && !signal.aborted) {
      const idleDuration = Date.now() - lastActivityTime;
      if (idleDuration >= IDLE_TIMEOUT_MS) {
        logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
          sessionDbId,
          idleDurationMs: idleDuration,
          thresholdMs: IDLE_TIMEOUT_MS
        });
        onIdleTimeout?.();
        return true;
      }
    }
    return false;
  }

  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); 
      };

      const onAbort = () => {
        cleanup();
        resolve(false); 
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); 
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
