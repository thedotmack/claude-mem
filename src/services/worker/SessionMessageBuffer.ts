import { EventEmitter } from 'events';
import type { PendingMessage, PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const CAPACITY_LOG_INTERVAL_MS = 60 * 1000;

export const SESSION_BUFFER_REJECTED = -1;
export const SESSION_BUFFER_MAX_MESSAGES = 200;
export const SESSION_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

export interface SessionMessageBufferLimits {
  maxMessagesPerSession: number;
  maxBytesPerSession: number;
}

interface BufferedMessage {
  id: number;
  message: PendingMessage;
  claimed: boolean;
  enqueuedAt: number;
  estimatedBytes: number;
}

export interface DrainOptions {
  sessionDbId: number;
  signal: AbortSignal;
  onIdleTimeout?: () => void;
  idleTimeoutMs?: number;
}

/**
 * Per-session in-RAM observation buffer. This replaces the durable
 * `pending_messages` SQLite queue (and the BullMQ engine that mirrored it).
 *
 * Why in-RAM and not durable: a buffered message is one tool-use fragment fed
 * to a stateful, non-deterministic reducer (the memory agent batches N
 * tool-uses into M observations using in-memory conversation context). The old
 * durable queue persisted the fragments but threw away the reducer state, so
 * "replaying" pending rows after a crash regenerated different/duplicate
 * observations or looped forever — that was the retry storm. The Claude Code
 * transcript JSONL is the real durable source of truth, and transcript replay
 * is the recovery path. So this buffer deliberately holds work only for the
 * worker process lifetime: no 'processing' state to resurrect on restart, no
 * startup sweep, no respawn-on-pending. If the worker dies, the buffer is gone
 * and recovery is a transcript replay.
 *
 * confirm()/resetClaimed() exist only as in-process control flow within a
 * single live generator pass (drop a stored batch; re-yield a batch that
 * couldn't be stored yet because the memory session id wasn't captured). They
 * never cross a process boundary.
 */
export class SessionMessageBuffer {
  private readonly buffers = new Map<number, BufferedMessage[]>();
  private readonly events = new Map<number, EventEmitter>();
  private readonly seenToolUseIds = new Map<number, Set<string>>();
  private readonly lastCapacityLogAt = new Map<number, number>();
  private nextId = 1;
  private readonly maxMessagesPerSession: number;
  private readonly maxBytesPerSession: number;

  constructor(
    private readonly onMutate?: () => void,
    limits: Partial<SessionMessageBufferLimits> = {},
  ) {
    this.maxMessagesPerSession = Math.max(
      1,
      Math.floor(limits.maxMessagesPerSession ?? SESSION_BUFFER_MAX_MESSAGES),
    );
    this.maxBytesPerSession = Math.max(
      1,
      Math.floor(limits.maxBytesPerSession ?? SESSION_BUFFER_MAX_BYTES),
    );
  }

  /**
   * Append a message. Returns the assigned id, or 0 if suppressed as a
   * duplicate. Dedup matches the old partial UNIQUE(content_session_id,
   * tool_use_id) index: only observations that carry a toolUseId are deduped,
   * and only against others in the same session for this worker's lifetime.
   */
  enqueue(sessionDbId: number, message: PendingMessage): number {
    const toolUseId = message.toolUseId;
    if (toolUseId && this.seenToolUseIds.get(sessionDbId)?.has(toolUseId)) {
      return 0;
    }

    const estimatedBytes = this.estimateMessageBytes(message);
    if (estimatedBytes > this.maxBytesPerSession) {
      this.logCapacityEvent(sessionDbId, 'message_too_large', {
        estimatedBytes,
        queueDepth: this.getPendingCount(sessionDbId),
      });
      return SESSION_BUFFER_REJECTED;
    }

    const list = this.getList(sessionDbId);
    let projectedCount = list.length + 1;
    let projectedBytes =
      list.reduce((sum, entry) => sum + entry.estimatedBytes, 0) + estimatedBytes;
    const victimIndexes: number[] = [];

    for (
      let index = 0;
      index < list.length &&
        (projectedCount > this.maxMessagesPerSession ||
          projectedBytes > this.maxBytesPerSession);
      index++
    ) {
      const candidate = list[index];
      if (candidate.claimed) {
        continue;
      }
      victimIndexes.push(index);
      projectedCount -= 1;
      projectedBytes -= candidate.estimatedBytes;
    }

    if (
      projectedCount > this.maxMessagesPerSession ||
      projectedBytes > this.maxBytesPerSession
    ) {
      this.logCapacityEvent(sessionDbId, 'claimed_work_protected', {
        estimatedBytes,
        queueDepth: list.length,
      });
      return SESSION_BUFFER_REJECTED;
    }

    for (let index = victimIndexes.length - 1; index >= 0; index--) {
      const [removed] = list.splice(victimIndexes[index], 1);
      if (removed?.message.toolUseId) {
        this.seenToolUseIds.get(sessionDbId)?.delete(removed.message.toolUseId);
      }
    }

    if (victimIndexes.length > 0) {
      this.logCapacityEvent(sessionDbId, 'oldest_unclaimed_evicted', {
        evictedCount: victimIndexes.length,
        queueDepth: list.length,
        estimatedBytes: projectedBytes,
      });
    }

    const id = this.nextId++;
    list.push({
      id,
      message,
      claimed: false,
      enqueuedAt: Date.now(),
      estimatedBytes,
    });
    if (toolUseId) {
      this.getSeen(sessionDbId).add(toolUseId);
    }
    this.onMutate?.();
    this.signal(sessionDbId);
    return id;
  }

  /** Remove a stored message by id. Returns 1 if found, 0 otherwise. */
  confirm(messageId: number): number {
    for (const list of this.buffers.values()) {
      const idx = list.findIndex(m => m.id === messageId);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.onMutate?.();
        return 1;
      }
    }
    return 0;
  }

  /** Un-claim all messages for a session so the iterator re-yields them. */
  resetClaimed(sessionDbId: number): number {
    const list = this.buffers.get(sessionDbId);
    if (!list) return 0;
    let reset = 0;
    for (const m of list) {
      if (m.claimed) {
        m.claimed = false;
        reset++;
      }
    }
    if (reset > 0) {
      this.onMutate?.();
      this.signal(sessionDbId);
    }
    return reset;
  }

  /** Drop everything buffered for a session. */
  clear(sessionDbId: number): number {
    const cleared = this.buffers.get(sessionDbId)?.length ?? 0;
    this.buffers.delete(sessionDbId);
    // Mirror dispose(): drop the dedup set too. Otherwise a clear() not followed
    // by dispose() leaves seenToolUseIds intact, so a later enqueue carrying a
    // previously-seen toolUseId is silently suppressed (returns 0) and lost.
    this.seenToolUseIds.delete(sessionDbId);
    this.lastCapacityLogAt.delete(sessionDbId);
    if (cleared > 0) {
      this.onMutate?.();
    }
    return cleared;
  }

  /** Forget a session entirely (buffer, dedup set, event emitter). */
  dispose(sessionDbId: number): void {
    this.buffers.delete(sessionDbId);
    this.seenToolUseIds.delete(sessionDbId);
    this.lastCapacityLogAt.delete(sessionDbId);
    this.events.get(sessionDbId)?.removeAllListeners();
    this.events.delete(sessionDbId);
  }

  getPendingCount(sessionDbId: number): number {
    return this.buffers.get(sessionDbId)?.length ?? 0;
  }

  getTotalDepth(): number {
    let total = 0;
    for (const list of this.buffers.values()) {
      total += list.length;
    }
    return total;
  }

  getPendingBytes(sessionDbId: number): number {
    return (this.buffers.get(sessionDbId) ?? [])
      .reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  }

  peekTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    return (this.buffers.get(sessionDbId) ?? []).map(m => ({
      message_type: m.message.type,
      tool_name: m.message.tool_name ?? null
    }));
  }

  /**
   * Drain buffered messages as they arrive. Yields one unclaimed message at a
   * time; when the buffer is empty it waits on the per-session event emitter
   * until a new message is enqueued, the abort signal fires, or the idle
   * timeout elapses (which triggers onIdleTimeout and ends the iterator so the
   * SDK subprocess is killed).
   */
  async *drain(options: DrainOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout, idleTimeoutMs = IDLE_TIMEOUT_MS } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      const claimed = this.claimNext(sessionDbId);
      if (claimed) {
        lastActivityTime = Date.now();
        yield {
          ...claimed.message,
          _persistentId: claimed.id,
          _originalTimestamp: claimed.enqueuedAt
        };
        continue;
      }

      const received = await this.waitForMessage(sessionDbId, signal, idleTimeoutMs);
      if (!received && !signal.aborted) {
        const idleDuration = Date.now() - lastActivityTime;
        if (idleDuration >= idleTimeoutMs) {
          logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
            sessionDbId,
            idleDurationMs: idleDuration,
            thresholdMs: idleTimeoutMs
          });
          onIdleTimeout?.();
          return;
        }
      } else {
        lastActivityTime = Date.now();
      }
    }
  }

  private claimNext(sessionDbId: number): BufferedMessage | null {
    const list = this.buffers.get(sessionDbId);
    if (!list) return null;
    const next = list.find(m => !m.claimed);
    if (!next) return null;
    next.claimed = true;
    this.onMutate?.();
    return next;
  }

  private waitForMessage(sessionDbId: number, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const events = this.getEvents(sessionDbId);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

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

      events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }

  private getList(sessionDbId: number): BufferedMessage[] {
    let list = this.buffers.get(sessionDbId);
    if (!list) {
      list = [];
      this.buffers.set(sessionDbId, list);
    }
    return list;
  }

  private getSeen(sessionDbId: number): Set<string> {
    let seen = this.seenToolUseIds.get(sessionDbId);
    if (!seen) {
      seen = new Set<string>();
      this.seenToolUseIds.set(sessionDbId, seen);
    }
    return seen;
  }

  private getEvents(sessionDbId: number): EventEmitter {
    let events = this.events.get(sessionDbId);
    if (!events) {
      events = new EventEmitter();
      this.events.set(sessionDbId, events);
    }
    return events;
  }

  private signal(sessionDbId: number): void {
    this.events.get(sessionDbId)?.emit('message');
  }

  private estimateMessageBytes(message: PendingMessage): number {
    try {
      return Buffer.byteLength(JSON.stringify(message), 'utf8');
    } catch {
      return this.maxBytesPerSession + 1;
    }
  }

  private logCapacityEvent(
    sessionDbId: number,
    reason: string,
    details: Record<string, number>,
  ): void {
    const now = Date.now();
    const lastLoggedAt = this.lastCapacityLogAt.get(sessionDbId) ?? 0;
    if (now >= lastLoggedAt && now - lastLoggedAt < CAPACITY_LOG_INTERVAL_MS) {
      return;
    }
    this.lastCapacityLogAt.set(sessionDbId, now);
    logger.warn('QUEUE', 'Session buffer capacity guard applied', {
      sessionId: sessionDbId,
      reason,
      maxMessages: this.maxMessagesPerSession,
      maxBytes: this.maxBytesPerSession,
      ...details,
    });
  }
}
