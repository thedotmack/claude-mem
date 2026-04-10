import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore - drainSessionMessages', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const MAX_RETRIES = 3;
  const CONTENT_SESSION_ID = 'test-drain-session';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, MAX_RETRIES);
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

  function setRetryCount(messageId: number, retryCount: number): void {
    db.run(`UPDATE pending_messages SET retry_count = ? WHERE id = ?`, [retryCount, messageId]);
  }

  function setStatusProcessing(messageId: number): void {
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [Date.now(), messageId]
    );
  }

  function getMessageRow(messageId: number): { status: string; retry_count: number; failed_at_epoch: number | null } {
    return db
      .query('SELECT status, retry_count, failed_at_epoch FROM pending_messages WHERE id = ?')
      .get(messageId) as { status: string; retry_count: number; failed_at_epoch: number | null };
  }

  test('requeues messages with retries remaining', () => {
    const id1 = enqueueMessage();
    const id2 = enqueueMessage();
    // Both start at retry_count=0

    const result = store.drainSessionMessages(sessionDbId);

    expect(result.requeued).toBe(2);
    expect(result.failed).toBe(0);

    const row1 = getMessageRow(id1);
    expect(row1.status).toBe('pending');
    expect(row1.retry_count).toBe(1);

    const row2 = getMessageRow(id2);
    expect(row2.status).toBe('pending');
    expect(row2.retry_count).toBe(1);
  });

  test('permanently fails messages with exhausted retries', () => {
    const id = enqueueMessage();
    setRetryCount(id, MAX_RETRIES); // at the limit

    const result = store.drainSessionMessages(sessionDbId);

    expect(result.failed).toBe(1);
    expect(result.requeued).toBe(0);

    const row = getMessageRow(id);
    expect(row.status).toBe('failed');
    expect(row.failed_at_epoch).not.toBeNull();
  });

  test('handles mixed retry states correctly', () => {
    const idFresh = enqueueMessage();       // retry_count=0 → requeue
    const idMid = enqueueMessage();         // retry_count=2 → requeue
    const idExhausted = enqueueMessage();   // retry_count=3 → fail

    setRetryCount(idMid, 2);
    setRetryCount(idExhausted, MAX_RETRIES);

    const result = store.drainSessionMessages(sessionDbId);

    expect(result.requeued).toBe(2);
    expect(result.failed).toBe(1);

    expect(getMessageRow(idFresh).status).toBe('pending');
    expect(getMessageRow(idFresh).retry_count).toBe(1);

    expect(getMessageRow(idMid).status).toBe('pending');
    expect(getMessageRow(idMid).retry_count).toBe(3);

    expect(getMessageRow(idExhausted).status).toBe('failed');
  });

  test('drains processing messages too (not only pending)', () => {
    const id = enqueueMessage();
    setStatusProcessing(id);

    const result = store.drainSessionMessages(sessionDbId);

    expect(result.requeued).toBe(1);
    expect(result.failed).toBe(0);

    const row = getMessageRow(id);
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  test('only affects the specified session', () => {
    const otherSessionId = createSDKSession(db, 'other-session', 'test-project', 'Other prompt');

    const idOwn = enqueueMessage();
    const idOther = store.enqueue(otherSessionId, 'other-session', {
      type: 'observation',
      tool_name: 'OtherTool',
      tool_input: {},
      tool_response: {},
      prompt_number: 1,
    });

    store.drainSessionMessages(sessionDbId);

    // Own session message was drained
    expect(getMessageRow(idOwn).status).toBe('pending'); // requeued
    expect(getMessageRow(idOwn).retry_count).toBe(1);

    // Other session message is untouched
    expect(getMessageRow(idOther).status).toBe('pending');
    expect(getMessageRow(idOther).retry_count).toBe(0);
  });

  test('requeued messages are visible to getSessionsWithPendingMessages', () => {
    enqueueMessage();
    enqueueMessage();

    const { requeued } = store.drainSessionMessages(sessionDbId);
    expect(requeued).toBe(2);

    const sessions = store.getSessionsWithPendingMessages();
    expect(sessions).toContain(sessionDbId);
  });

  test('fully exhausted drain removes session from getSessionsWithPendingMessages', () => {
    const id = enqueueMessage();
    setRetryCount(id, MAX_RETRIES);

    const { failed } = store.drainSessionMessages(sessionDbId);
    expect(failed).toBe(1);

    const sessions = store.getSessionsWithPendingMessages();
    expect(sessions).not.toContain(sessionDbId);
  });

  test('returns zero counts when no messages exist', () => {
    const result = store.drainSessionMessages(sessionDbId);
    expect(result.failed).toBe(0);
    expect(result.requeued).toBe(0);
  });

  test('drain increments retry_count preventing infinite requeue loops', () => {
    const id = enqueueMessage();
    setRetryCount(id, MAX_RETRIES - 1); // one retry left

    // First drain: requeues (retry_count goes to MAX_RETRIES)
    const first = store.drainSessionMessages(sessionDbId);
    expect(first.requeued).toBe(1);
    expect(getMessageRow(id).retry_count).toBe(MAX_RETRIES);

    // Second drain: exhausted, permanently fails
    const second = store.drainSessionMessages(sessionDbId);
    expect(second.failed).toBe(1);
    expect(getMessageRow(id).status).toBe('failed');
  });
});
