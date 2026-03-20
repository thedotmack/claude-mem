import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import type { DbAdapter } from '../../../src/services/sqlite/adapter.js';

describe('PendingMessageStore - Self-Healing claimNextMessage', () => {
  let db: DbAdapter;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const CONTENT_SESSION_ID = 'test-self-heal';

  beforeEach(async () => {
    const cmdb = await ClaudeMemDatabase.create(':memory:');
    db = cmdb.db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = await createSDKSession(db, CONTENT_SESSION_ID, 'test-project', 'Test prompt');
  });

  afterEach(async () => {
    await db.close();
  });

  async function enqueueMessage(overrides: Partial<PendingMessage> = {}): Promise<number> {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
      ...overrides,
    };
    return await store.enqueue(sessionDbId, CONTENT_SESSION_ID, message);
  }

  /**
   * Helper to simulate a stuck processing message by directly updating the DB
   * to set started_processing_at_epoch to a time in the past (>60s ago)
   */
  async function makeMessageStaleProcessing(messageId: number): Promise<void> {
    const staleTimestamp = Date.now() - 120_000; // 2 minutes ago (well past 60s threshold)
    await db.execute(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, messageId]
    );
  }

  test('stuck processing messages are recovered on next claim', async () => {
    // Enqueue a message and make it stuck in processing
    const msgId = await enqueueMessage();
    await makeMessageStaleProcessing(msgId);

    // Verify it's stuck (status = processing)
    const beforeResult = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [msgId]);
    const beforeClaim = beforeResult.rows[0] as { status: string };
    expect(beforeClaim.status).toBe('processing');

    // claimNextMessage should self-heal: reset the stuck message, then claim it
    const claimed = await store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);
    // It should now be in 'processing' status again (freshly claimed)
    const afterResult = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [msgId]);
    const afterClaim = afterResult.rows[0] as { status: string };
    expect(afterClaim.status).toBe('processing');
  });

  test('actively processing messages are NOT recovered', async () => {
    // Enqueue two messages
    const activeId = await enqueueMessage();
    const pendingId = await enqueueMessage();

    // Make the first one actively processing (recent timestamp, NOT stale)
    const recentTimestamp = Date.now() - 5_000; // 5 seconds ago (well within 60s threshold)
    await db.execute(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [recentTimestamp, activeId]
    );

    // claimNextMessage should NOT reset the active one — should claim the pending one instead
    const claimed = await store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(pendingId);

    // The active message should still be processing
    const activeResult = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [activeId]);
    const activeMsg = activeResult.rows[0] as { status: string };
    expect(activeMsg.status).toBe('processing');
  });

  test('recovery and claim is atomic within single call', async () => {
    // Enqueue three messages
    const stuckId = await enqueueMessage();
    const pendingId1 = await enqueueMessage();
    const pendingId2 = await enqueueMessage();

    // Make the first one stuck
    await makeMessageStaleProcessing(stuckId);

    // Single claimNextMessage should reset stuck AND claim oldest pending (which is the reset stuck one)
    const claimed = await store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    // The stuck message was reset to pending, and being oldest, it gets claimed
    expect(claimed!.id).toBe(stuckId);

    // The other two should still be pending
    const msg1Result = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [pendingId1]);
    const msg2Result = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [pendingId2]);
    const msg1 = msg1Result.rows[0] as { status: string };
    const msg2 = msg2Result.rows[0] as { status: string };
    expect(msg1.status).toBe('pending');
    expect(msg2.status).toBe('pending');
  });

  test('no messages returns null without error', async () => {
    const claimed = await store.claimNextMessage(sessionDbId);
    expect(claimed).toBeNull();
  });

  test('self-healing only affects the specified session', async () => {
    // Create a second session
    const session2Id = await createSDKSession(db, 'other-session', 'test-project', 'Test');

    // Enqueue and make stuck in session 1
    const stuckInSession1 = await enqueueMessage();
    await makeMessageStaleProcessing(stuckInSession1);

    // Enqueue in session 2
    const msg: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    const session2MsgId = await store.enqueue(session2Id, 'other-session', msg);
    await makeMessageStaleProcessing(session2MsgId);

    // Claim for session 2 — should only heal session 2's stuck message
    const claimed = await store.claimNextMessage(session2Id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(session2MsgId);

    // Session 1's stuck message should still be stuck (not healed by session 2's claim)
    const session1Result = await db.execute('SELECT status FROM pending_messages WHERE id = ?', [stuckInSession1]);
    const session1Msg = session1Result.rows[0] as { status: string };
    expect(session1Msg.status).toBe('processing');
  });
});
