import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const CONTENT_SESSION_ID = 'test-queue-store';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db);
    sessionDbId = createSDKSession(db, CONTENT_SESSION_ID, 'test-project', 'Test prompt');
  });

  afterEach(() => {
    db.close();
  });

  function enqueueMessage(overrides: Partial<PendingMessage> = {}): number {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
      ...overrides,
    };
    return store.enqueue(sessionDbId, CONTENT_SESSION_ID, message);
  }

  test('claimNextMessage claims pending messages in FIFO order', () => {
    const firstId = enqueueMessage({ tool_name: 'First' });
    const secondId = enqueueMessage({ tool_name: 'Second' });

    const first = store.claimNextMessage(sessionDbId);
    const second = store.claimNextMessage(sessionDbId);

    expect(first?.id).toBe(firstId);
    expect(second?.id).toBe(secondId);
    expect(first?.status).toBe('processing');
    expect(second?.status).toBe('processing');
  });

  test('claimNextMessage ignores already processing messages until reset', () => {
    const firstId = enqueueMessage({ tool_name: 'First' });
    const secondId = enqueueMessage({ tool_name: 'Second' });

    expect(store.claimNextMessage(sessionDbId)?.id).toBe(firstId);
    expect(store.claimNextMessage(sessionDbId)?.id).toBe(secondId);
    expect(store.claimNextMessage(sessionDbId)).toBeNull();

    expect(store.resetProcessingToPending(sessionDbId)).toBe(2);
    expect(store.claimNextMessage(sessionDbId)?.id).toBe(firstId);
  });

  test('resetProcessingToPending only affects the specified session', () => {
    const session2Id = createSDKSession(db, 'other-session', 'test-project', 'Test');
    const session1MessageId = enqueueMessage();
    const session2MessageId = store.enqueue(session2Id, 'other-session', {
      type: 'observation',
      tool_name: 'OtherTool',
    });

    expect(store.claimNextMessage(sessionDbId)?.id).toBe(session1MessageId);
    expect(store.claimNextMessage(session2Id)?.id).toBe(session2MessageId);

    expect(store.resetProcessingToPending(sessionDbId)).toBe(1);

    const session1Msg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(session1MessageId) as { status: string };
    const session2Msg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(session2MessageId) as { status: string };
    expect(session1Msg.status).toBe('pending');
    expect(session2Msg.status).toBe('processing');
  });

  test('clearPendingForSession removes pending and processing rows', () => {
    const firstId = enqueueMessage({ tool_name: 'First' });
    enqueueMessage({ tool_name: 'Second' });

    expect(store.claimNextMessage(sessionDbId)?.id).toBe(firstId);
    expect(store.getPendingCount(sessionDbId)).toBe(2);
    expect(store.clearPendingForSession(sessionDbId)).toBe(2);
    expect(store.getPendingCount(sessionDbId)).toBe(0);
  });

  test('deduplicates by content session and tool use id', () => {
    const firstId = enqueueMessage({ toolUseId: 'tool-1' });
    const duplicateId = enqueueMessage({ toolUseId: 'tool-1' });

    expect(firstId).toBeGreaterThan(0);
    expect(duplicateId).toBe(0);
    expect(store.getPendingCount(sessionDbId)).toBe(1);
  });

  test('queue depth helpers count pending and processing rows across sessions', () => {
    const session2Id = createSDKSession(db, 'other-depth-session', 'test-project', 'Test');

    enqueueMessage();
    store.enqueue(session2Id, 'other-depth-session', { type: 'summarize' });
    store.claimNextMessage(sessionDbId);

    expect(store.getPendingCount(sessionDbId)).toBe(1);
    expect(store.getPendingCount(session2Id)).toBe(1);
    expect(store.getTotalQueueDepth()).toBe(2);
    expect(store.hasAnyPendingWork()).toBe(true);
    expect(store.getSessionsWithPendingMessages()).toEqual([sessionDbId, session2Id]);
  });
});
