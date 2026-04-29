import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore - Self-Healing claimNextMessage', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const CONTENT_SESSION_ID = 'test-self-heal';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
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

  function makeMessageStaleProcessing(messageId: number): void {
    const staleTimestamp = Date.now() - 120_000; 
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, messageId]
    );
  }

  test('stuck processing messages are recovered on next claim', () => {
    const msgId = enqueueMessage();
    makeMessageStaleProcessing(msgId);

    const beforeClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(beforeClaim.status).toBe('processing');

    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);
    const afterClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(afterClaim.status).toBe('processing');
  });

  test('actively processing messages are NOT recovered', () => {
    const activeId = enqueueMessage();
    const pendingId = enqueueMessage();

    const recentTimestamp = Date.now() - 5_000; 
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [recentTimestamp, activeId]
    );

    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(pendingId);

    const activeMsg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(activeId) as { status: string };
    expect(activeMsg.status).toBe('processing');
  });

  test('recovery and claim is atomic within single call', () => {
    const stuckId = enqueueMessage();
    const pendingId1 = enqueueMessage();
    const pendingId2 = enqueueMessage();

    makeMessageStaleProcessing(stuckId);

    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(stuckId);

    const msg1 = db.query('SELECT status FROM pending_messages WHERE id = ?').get(pendingId1) as { status: string };
    const msg2 = db.query('SELECT status FROM pending_messages WHERE id = ?').get(pendingId2) as { status: string };
    expect(msg1.status).toBe('pending');
    expect(msg2.status).toBe('pending');
  });

  test('no messages returns null without error', () => {
    const claimed = store.claimNextMessage(sessionDbId);
    expect(claimed).toBeNull();
  });

  test('self-healing only affects the specified session', () => {
    const session2Id = createSDKSession(db, 'other-session', 'test-project', 'Test');

    const stuckInSession1 = enqueueMessage();
    makeMessageStaleProcessing(stuckInSession1);

    const msg: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    const session2MsgId = store.enqueue(session2Id, 'other-session', msg);
    makeMessageStaleProcessing(session2MsgId);

    const claimed = store.claimNextMessage(session2Id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(session2MsgId);

    const session1Msg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(stuckInSession1) as { status: string };
    expect(session1Msg.status).toBe('processing');
  });
});
