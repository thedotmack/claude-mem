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

  /**
   * Helper to simulate a stuck processing message by directly updating the DB
   * to set started_processing_at_epoch to a time in the past (>60s ago)
   */
  function makeMessageStaleProcessing(messageId: number): void {
    const staleTimestamp = Date.now() - 120_000; // 2 minutes ago (well past 60s threshold)
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, messageId]
    );
  }

  test('stuck processing messages are recovered on next claim', () => {
    // Enqueue a message and make it stuck in processing
    const msgId = enqueueMessage();
    makeMessageStaleProcessing(msgId);

    // Verify it's stuck (status = processing)
    const beforeClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(beforeClaim.status).toBe('processing');

    // claimNextMessage should self-heal: reset the stuck message, then claim it
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);
    // It should now be in 'processing' status again (freshly claimed)
    const afterClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(afterClaim.status).toBe('processing');
  });

  test('actively processing messages are NOT recovered', () => {
    // Enqueue two messages
    const activeId = enqueueMessage();
    const pendingId = enqueueMessage();

    // Make the first one actively processing (recent timestamp, NOT stale)
    const recentTimestamp = Date.now() - 5_000; // 5 seconds ago (well within 60s threshold)
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [recentTimestamp, activeId]
    );

    // claimNextMessage should NOT reset the active one — should claim the pending one instead
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(pendingId);

    // The active message should still be processing
    const activeMsg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(activeId) as { status: string };
    expect(activeMsg.status).toBe('processing');
  });

  test('recovery and claim is atomic within single call', () => {
    // Enqueue three messages
    const stuckId = enqueueMessage();
    const pendingId1 = enqueueMessage();
    const pendingId2 = enqueueMessage();

    // Make the first one stuck
    makeMessageStaleProcessing(stuckId);

    // Single claimNextMessage should reset stuck AND claim oldest pending (which is the reset stuck one)
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    // The stuck message was reset to pending, and being oldest, it gets claimed
    expect(claimed!.id).toBe(stuckId);

    // The other two should still be pending
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
    // Create a second session
    const session2Id = createSDKSession(db, 'other-session', 'test-project', 'Test');

    // Enqueue and make stuck in session 1
    const stuckInSession1 = enqueueMessage();
    makeMessageStaleProcessing(stuckInSession1);

    // Enqueue in session 2
    const msg: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    const session2MsgId = store.enqueue(session2Id, 'other-session', msg);
    makeMessageStaleProcessing(session2MsgId);

    // Claim for session 2 — should only heal session 2's stuck message
    const claimed = store.claimNextMessage(session2Id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(session2MsgId);

    // Session 1's stuck message should still be stuck (not healed by session 2's claim)
    const session1Msg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(stuckInSession1) as { status: string };
    expect(session1Msg.status).toBe('processing');
  });
});

describe('PendingMessageStore - Recovery Limits (#1262)', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const CONTENT_SESSION_ID = 'test-recovery-limits';

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

  function setMessageAge(messageId: number, ageMs: number): void {
    const timestamp = Date.now() - ageMs;
    db.run(
      `UPDATE pending_messages SET created_at_epoch = ? WHERE id = ?`,
      [timestamp, messageId]
    );
  }

  describe('age-based cleanup in resetStaleProcessingMessages', () => {
    test('deletes pending messages older than 24 hours', () => {
      const oldId = enqueueMessage();
      const recentId = enqueueMessage();

      // Make oldId 25 hours old
      setMessageAge(oldId, 25 * 60 * 60 * 1000);
      // Make recentId 1 hour old
      setMessageAge(recentId, 1 * 60 * 60 * 1000);

      store.resetStaleProcessingMessages(0);

      // Old message should be deleted
      const oldMsg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(oldId);
      expect(oldMsg).toBeNull();

      // Recent message should still exist
      const recentMsg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(recentId);
      expect(recentMsg).not.toBeNull();
    });

    test('deletes processing messages older than 24 hours', () => {
      const oldId = enqueueMessage();
      setMessageAge(oldId, 25 * 60 * 60 * 1000);

      // Mark as processing
      const staleTimestamp = Date.now() - 25 * 60 * 60 * 1000;
      db.run(
        `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
        [staleTimestamp, oldId]
      );

      store.resetStaleProcessingMessages(0);

      // Old processing message should be deleted by age pruning
      const msg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(oldId);
      expect(msg).toBeNull();
    });

    test('does not delete failed messages (only pending/processing)', () => {
      const failedId = enqueueMessage();
      setMessageAge(failedId, 25 * 60 * 60 * 1000);
      db.run(
        `UPDATE pending_messages SET status = 'failed', failed_at_epoch = ? WHERE id = ?`,
        [Date.now(), failedId]
      );

      store.resetStaleProcessingMessages(0);

      // Failed message should NOT be deleted (age pruning only targets pending/processing)
      const msg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(failedId);
      expect(msg).not.toBeNull();
    });

    test('does not delete messages younger than 24 hours', () => {
      const recentId = enqueueMessage();
      setMessageAge(recentId, 23 * 60 * 60 * 1000); // 23 hours old

      store.resetStaleProcessingMessages(0);

      const msg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(recentId);
      expect(msg).not.toBeNull();
    });
  });

  describe('pruneExcessPendingMessages', () => {
    test('deletes excess messages beyond batch size limit per session', () => {
      // Enqueue 55 messages with staggered timestamps
      const messageIds: number[] = [];
      for (let i = 0; i < 55; i++) {
        const id = enqueueMessage({ prompt_number: i });
        messageIds.push(id);
        // Set created_at_epoch so ordering is deterministic (oldest first)
        setMessageAge(id, (55 - i) * 60 * 1000); // 55min, 54min, ..., 1min ago
      }

      const deleted = store.pruneExcessPendingMessages();

      // Should have deleted 5 messages (55 - 50 = 5)
      expect(deleted).toBe(5);

      // Count remaining pending messages for this session
      const remaining = db.query(
        `SELECT COUNT(*) as count FROM pending_messages WHERE session_db_id = ? AND status = 'pending'`
      ).get(sessionDbId) as { count: number };
      expect(remaining.count).toBe(50);

      // The 5 oldest should be gone (messageIds[0..4])
      for (let i = 0; i < 5; i++) {
        const msg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(messageIds[i]);
        expect(msg).toBeNull();
      }

      // The 50 newest should still exist (messageIds[5..54])
      for (let i = 5; i < 55; i++) {
        const msg = db.query('SELECT * FROM pending_messages WHERE id = ?').get(messageIds[i]);
        expect(msg).not.toBeNull();
      }
    });

    test('does not delete anything when under batch size limit', () => {
      // Enqueue 10 messages (well under 50 limit)
      for (let i = 0; i < 10; i++) {
        enqueueMessage({ prompt_number: i });
      }

      const deleted = store.pruneExcessPendingMessages();
      expect(deleted).toBe(0);

      const remaining = db.query(
        `SELECT COUNT(*) as count FROM pending_messages WHERE session_db_id = ? AND status = 'pending'`
      ).get(sessionDbId) as { count: number };
      expect(remaining.count).toBe(10);
    });

    test('prunes each session independently', () => {
      const session2Id = createSDKSession(db, 'session-2', 'test-project', 'Test');
      const msg: PendingMessage = {
        type: 'observation',
        tool_name: 'TestTool',
        tool_input: { test: 'input' },
        tool_response: { test: 'response' },
        prompt_number: 1,
      };

      // Session 1: 55 messages (5 over limit)
      for (let i = 0; i < 55; i++) {
        const id = enqueueMessage({ prompt_number: i });
        setMessageAge(id, (55 - i) * 60 * 1000);
      }

      // Session 2: 52 messages (2 over limit)
      for (let i = 0; i < 52; i++) {
        const id = store.enqueue(session2Id, 'session-2', { ...msg, prompt_number: i });
        const timestamp = Date.now() - (52 - i) * 60 * 1000;
        db.run(`UPDATE pending_messages SET created_at_epoch = ? WHERE id = ?`, [timestamp, id]);
      }

      const deleted = store.pruneExcessPendingMessages();
      expect(deleted).toBe(7); // 5 from session 1 + 2 from session 2

      const s1Remaining = db.query(
        `SELECT COUNT(*) as count FROM pending_messages WHERE session_db_id = ? AND status = 'pending'`
      ).get(sessionDbId) as { count: number };
      expect(s1Remaining.count).toBe(50);

      const s2Remaining = db.query(
        `SELECT COUNT(*) as count FROM pending_messages WHERE session_db_id = ? AND status = 'pending'`
      ).get(session2Id) as { count: number };
      expect(s2Remaining.count).toBe(50);
    });

    test('returns 0 when no sessions have pending messages', () => {
      const deleted = store.pruneExcessPendingMessages();
      expect(deleted).toBe(0);
    });
  });
});
