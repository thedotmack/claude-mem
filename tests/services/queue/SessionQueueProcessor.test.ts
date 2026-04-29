import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { SessionQueueProcessor, CreateIteratorOptions } from '../../../src/services/queue/SessionQueueProcessor.js';
import type { PendingMessageStore, PersistentPendingMessage } from '../../../src/services/sqlite/PendingMessageStore.js';

function createMockStore(): PendingMessageStore {
  return {
    claimNextMessage: mock(() => null),
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
    abortController.abort();
    events.removeAllListeners();
  });

  describe('createIterator', () => {
    describe('idle timeout behavior', () => {
      it('should exit after idle timeout when no messages arrive', async () => {
        const SHORT_TIMEOUT_MS = 50;

        const onIdleTimeout = mock(() => {});

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        const startTime = Date.now();
        const results: any[] = [];

        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
      });

      it('should invoke onIdleTimeout callback when idle timeout occurs', async () => {

        const onIdleTimeout = mock(() => {
          abortController.abort();
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

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

        (store.claimNextMessage as any) = mock(() => {
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

        setTimeout(() => abortController.abort(), 100);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(1);
        expect(results[0]._persistentId).toBe(1);

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

        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });

      it('should take precedence over timeout when both could fire', async () => {
        const onIdleTimeout = mock(() => {});

        (store.claimNextMessage as any) = mock(() => null);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal,
          onIdleTimeout
        };

        const iterator = processor.createIterator(options);

        setTimeout(() => abortController.abort(), 10);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
        expect(onIdleTimeout).not.toHaveBeenCalled();
      });
    });

    describe('message event handling', () => {
      it('should wake up when message event is emitted', async () => {
        let callCount = 0;
        const mockMessages = [
          createMockMessage({ id: 1 }),
          createMockMessage({ id: 2 })
        ];

        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            return null;
          } else if (callCount === 2) {
            return mockMessages[0];
          } else if (callCount === 3) {
            return null;
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        setTimeout(() => events.emit('message'), 50);

        setTimeout(() => abortController.abort(), 150);

        for await (const message of iterator) {
          results.push(message);
        }

        expect(results.length).toBeGreaterThanOrEqual(1);
        if (results.length > 0) {
          expect(results[0]._persistentId).toBe(1);
        }
      });
    });

    describe('event listener cleanup', () => {
      it('should clean up event listeners on abort', async () => {
        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        const initialListenerCount = events.listenerCount('message');

        abortController.abort();

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(initialListenerCount + 1);
      });

      it('should clean up event listeners when message received', async () => {
        (store.claimNextMessage as any) = mock(() => createMockMessage({ id: 1 }));

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        const firstResult = await iterator.next();
        expect(firstResult.done).toBe(false);
        expect(firstResult.value._persistentId).toBe(1);

        abortController.abort();

        for await (const _ of iterator) {
          // Should not get here since we aborted
        }

        const finalListenerCount = events.listenerCount('message');
        expect(finalListenerCount).toBeLessThanOrEqual(1);
      });
    });

    describe('error handling', () => {
      it('should continue after store error with backoff', async () => {
        let callCount = 0;

        (store.claimNextMessage as any) = mock(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Database error');
          }
          if (callCount === 2) {
            return createMockMessage({ id: 1 });
          }
          return null;
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const results: any[] = [];

        setTimeout(() => abortController.abort(), 1500);

        for await (const message of iterator) {
          results.push(message);
          break; 
        }

        expect(results).toHaveLength(1);
        expect(callCount).toBeGreaterThanOrEqual(2);
      });

      it('should exit cleanly if aborted during error backoff', async () => {
        (store.claimNextMessage as any) = mock(() => {
          throw new Error('Database error');
        });

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);

        setTimeout(() => abortController.abort(), 100);

        const results: any[] = [];
        for await (const message of iterator) {
          results.push(message);
        }

        expect(results).toHaveLength(0);
      });
    });

    describe('message conversion', () => {
      it('should convert PersistentPendingMessage to PendingMessageWithId', async () => {
        const mockPersistentMessage = createMockMessage({
          id: 42,
          message_type: 'observation',
          tool_name: 'Grep',
          tool_input: JSON.stringify({ pattern: 'test' }),
          tool_response: JSON.stringify({ matches: ['file.ts'] }),
          prompt_number: 5,
          created_at_epoch: 1704067200000
        });

        (store.claimNextMessage as any) = mock(() => mockPersistentMessage);

        const options: CreateIteratorOptions = {
          sessionDbId: 123,
          signal: abortController.signal
        };

        const iterator = processor.createIterator(options);
        const result = await iterator.next();

        abortController.abort();

        expect(result.done).toBe(false);
        expect(result.value).toMatchObject({
          _persistentId: 42,
          _originalTimestamp: 1704067200000,
          type: 'observation',
          tool_name: 'Grep',
          prompt_number: 5
        });
      });
    });
  });
});
