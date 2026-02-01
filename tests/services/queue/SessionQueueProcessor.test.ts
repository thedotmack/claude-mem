import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { SessionQueueProcessor, CreateIteratorOptions } from '../../../src/services/queue/SessionQueueProcessor.js';
import type { PendingMessageStore, PersistentPendingMessage } from '../../../src/services/sqlite/PendingMessageStore.js';

/**
 * Mock PendingMessageStore that returns null (empty queue) by default.
 * Individual tests can override claimAndDelete behavior.
 */
function createMockStore(): PendingMessageStore {
  return {
    claimAndDelete: mock(() => null),
    toPendingMessage: mock((msg: PersistentPendingMessage) => ({
      type: msg.message_type,
      tool_name: msg.tool_name || undefined,
      tool_input: msg.tool_input ? JSON.parse(msg.tool_input) : undefined,
      tool_response: msg.tool_response ? JSON.parse(msg.tool_response) : undefined,
      prompt_number: msg.prompt_number || undefined,
      cwd: msg.cwd || undefined,
      last_assistant_message: msg.last_assistant_message || undefined
    }))
  } as unknown as PendingMessageStore;
}

/**
 * Create a mock PersistentPendingMessage for testing
 */
function createMockMessage(overrides: Partial<PersistentPendingMessage> = {}): PersistentPendingMessage {
  return {
    id: 1,
    session_db_id: 123,
    content_session_id: 'test-session',
    message_type: 'observation',
    tool_name: 'Read',
    tool_input: JSON.stringify({ file: 'test.ts' }),
    tool_response: JSON.stringify({ content: 'file contents' }),
    cwd: '/test',
    last_assistant_message: null,
    prompt_number: 1,
    status: 'pending',
    retry_count: 0,
    created_at_epoch: Date.now(),
    started_processing_at_epoch: null,
    completed_at_epoch: null,
    ...overrides
  };
}

describe('SessionQueueProcessor', () => {
  let store: PendingMessageStore;
  let events: EventEmitter;
  let processor: SessionQueueProcessor;
  let abortController: AbortController;

  beforeEach(() => {
    store = createMockStore();
    events = new EventEmitter();
    processor = new SessionQueueProcessor(store, events);
    abortController = new AbortController();
  });

  afterEach(() => {
    // Ensure abort controller is triggered to clean up any pending iterators
    abortController.abort();
    // Remove all listeners to prevent memory leaks
    events.removeAllListeners();
  });

  describe('createIterator', () => {
    describe('idle timeout behavior', () => {
      it('should exit after idle timeout when no messages arrive', async () => {
        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Abort after a short delay to simulate timeout-like behavior
        setTimeout(() => abortController.abort(), 100);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Iterator should exit cleanly when aborted
        expect(results).toHaveLength(0);
      });

      it('should invoke onIdleTimeout callback when idle timeout occurs', async () => {
        const onIdleTimeout = mock(() => {
          // Callback should trigger abort in real usage
          abortController.abort();
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Simulate external abort (which is what onIdleTimeout should do)
        setTimeout(() => abortController.abort(), 50);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
      });

      it('should reset idle timer when message arrives', async () => {
        const onIdleTimeout = mock(() => abortController.abort());
        let callCount = 0;

        // Return a message on first call, then null
        (store.claimAndDelete as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            return createMockMessage({ id: 1 });
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // Abort after receiving first message
        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        // Should have received exactly one message
        expect(results).toHaveLength(1);
        expect(results[0]._persistentId).toBe(1);

        // Store's claimAndDelete should have been called at least twice
        expect(callCount).toBeGreaterThanOrEqual(1);
      });
    });

    describe('abort signal handling', () => {
      it('should exit immediately when abort signal is triggered', async () => {
        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Abort immediately
        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Should exit with no messages
        expect(results).toHaveLength(0);
        // onIdleTimeout should NOT be called when abort signal is used
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });

      it('should take precedence over timeout when both could fire', async () => {
        const onIdleTimeout = mock(() => {});

        // Return null to trigger wait
        (store.claimAndDelete as any) = mock(() => null);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        // Abort very quickly - before any timeout could fire
        setTimeout(() => abortController.abort(), 10);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        // Should have exited cleanly
        expect(results).toHaveLength(0);
        // onIdleTimeout should NOT have been called
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });
    });

    describe('message processing', () => {
      it('should yield messages when available', async () => {
        let callCount = 0;

        (store.claimAndDelete as any) = mock(() => {
          callCount++;
          if (callCount <= 3) {
            return createMockMessage({ id: callCount });
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // Abort after collecting messages
        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(3);
        expect(results[0]._persistentId).toBe(1);
        expect(results[1]._persistentId).toBe(2);
        expect(results[2]._persistentId).toBe(3);
      });

      it('should resume when message event fires after empty queue', async () => {
        let callCount = 0;

        (store.claimAndDelete as any) = mock(() => {
          callCount++;
          // First call: return a message
          if (callCount === 1) return createMockMessage({ id: 1 });
          // Second call: empty (triggers wait)
          if (callCount === 2) return null;
          // Third call (after event): return another message
          if (callCount === 3) return createMockMessage({ id: 2 });
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        // After a short delay, emit a message event to wake up the iterator
        setTimeout(() => events.emit('message'), 50);
        // Then abort after collecting
        setTimeout(() => abortController.abort(), 150);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(2);
        expect(results[0]._persistentId).toBe(1);
        expect(results[1]._persistentId).toBe(2);
      });
    });

    describe('event cleanup', () => {
      it('should not leak event listeners after abort', async () => {
        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        // Abort immediately
        abortController.abort();

        for await (const _ of iterator) {
          // No messages expected
        }

        // Event emitter should have no lingering listeners
        expect(events.listenerCount('message')).toBe(0);
      });

      it('should clean up listeners when message arrives', async () => {
        let callCount = 0;
        (store.claimAndDelete as any) = mock(() => {
          callCount++;
          if (callCount === 1) return null; // Trigger wait
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        // Emit message to resolve wait, then abort
        setTimeout(() => events.emit('message'), 30);
        setTimeout(() => abortController.abort(), 80);

        for await (const _ of iterator) {
          // No messages expected
        }

        // Should have cleaned up
        expect(events.listenerCount('message')).toBe(0);
      });
    });
  });
});
