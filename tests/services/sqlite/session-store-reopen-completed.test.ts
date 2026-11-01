import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionCompletionHandler } from '../../../src/services/worker/session/SessionCompletionHandler.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';
import type { SessionEventBroadcaster } from '../../../src/services/worker/events/SessionEventBroadcaster.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

/**
 * Issue #4080.
 *
 * Once finalizeSession marks an sdk_sessions row 'completed', nothing put it
 * back. A session that carried on — a `claude --resume`, or one finalized
 * while it was still live — kept the FIRST end's completed_at for good, while
 * new prompts landed under the same row and every later end was skipped.
 *
 * Each cell that asserts the fix pairs with the control that shows what the
 * same sequence does without the reopen, so a green file means the sequence
 * was repaired rather than the harness seeing nothing.
 */
type Row = { status: string; completed_at: string | null; completed_at_epoch: number | null };

function readRow(store: SessionStore, id: number): Row {
  return store.db.prepare(
    'SELECT status, completed_at, completed_at_epoch FROM sdk_sessions WHERE id = ?'
  ).get(id) as Row;
}

describe('SessionStore.reopenCompletedSession (#4080)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('the defect: a completed row stays completed while later prompts land under it', () => {
    const id = store.createSDKSession('resumed', 'project', 'first prompt');
    store.markSessionCompleted(id);
    const firstEnd = readRow(store, id).completed_at_epoch;

    // The continued session's next prompt resolves to the SAME row.
    const again = store.createSDKSession('resumed', 'project', 'second prompt');
    expect(again).toBe(id);

    const row = readRow(store, id);
    expect(row.status).toBe('completed');
    expect(row.completed_at_epoch).toBe(firstEnd);
  });

  it('reopening puts the row back to active and clears both completion stamps', () => {
    const id = store.createSDKSession('resumed', 'project', 'first prompt');
    store.markSessionCompleted(id);

    store.reopenCompletedSession(id);

    const row = readRow(store, id);
    expect(row.status).toBe('active');
    expect(row.completed_at).toBeNull();
    expect(row.completed_at_epoch).toBeNull();
  });

  it('the next end stamps the real completion time, not the first one', async () => {
    const id = store.createSDKSession('resumed', 'project', 'first prompt');
    store.markSessionCompleted(id);
    const firstEnd = readRow(store, id).completed_at_epoch as number;

    await Bun.sleep(2);
    store.reopenCompletedSession(id);
    store.markSessionCompleted(id);

    const row = readRow(store, id);
    expect(row.status).toBe('completed');
    expect(row.completed_at_epoch as number).toBeGreaterThan(firstEnd);
  });

  it('is a no-op on a row that is already active', () => {
    const id = store.createSDKSession('live', 'project', 'prompt');

    store.reopenCompletedSession(id);

    const row = readRow(store, id);
    expect(row.status).toBe('active');
    expect(row.completed_at).toBeNull();
  });

  it('touches only the row it is given', () => {
    const kept = store.createSDKSession('other', 'project', 'prompt');
    const reopened = store.createSDKSession('resumed', 'project', 'prompt');
    store.markSessionCompleted(kept);
    store.markSessionCompleted(reopened);

    store.reopenCompletedSession(reopened);

    expect(readRow(store, kept).status).toBe('completed');
    expect(readRow(store, kept).completed_at).not.toBeNull();
    expect(readRow(store, reopened).status).toBe('active');
  });

  it('leaves a failed row failed', () => {
    const id = store.createSDKSession('crashed', 'project', 'prompt');
    store.db.prepare("UPDATE sdk_sessions SET status = 'failed' WHERE id = ?").run(id);

    store.reopenCompletedSession(id);

    expect(readRow(store, id).status).toBe('failed');
  });

  it('does not throw on a session id that does not exist', () => {
    expect(() => store.reopenCompletedSession(99999)).not.toThrow();
  });
});

describe('finalizeSession after a reopen (#4080)', () => {
  let store: SessionStore;

  function buildHandler(): { handler: SessionCompletionHandler; broadcast: ReturnType<typeof mock> } {
    const broadcast = mock(() => {});
    const handler = new SessionCompletionHandler(
      {} as unknown as SessionManager,
      { broadcastSessionCompleted: broadcast } as unknown as SessionEventBroadcaster,
      { getSessionStore: () => store } as unknown as DatabaseManager
    );
    return { handler, broadcast };
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('the control: without a reopen the second end is skipped entirely', async () => {
    const id = store.createSDKSession('resumed', 'project', 'prompt');
    const { handler, broadcast } = buildHandler();

    await handler.finalizeSession(id);
    const firstEnd = readRow(store, id).completed_at_epoch;
    await Bun.sleep(2);
    await handler.finalizeSession(id);

    expect(readRow(store, id).completed_at_epoch).toBe(firstEnd);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('after a reopen the second end completes the session again', async () => {
    const id = store.createSDKSession('resumed', 'project', 'prompt');
    const { handler, broadcast } = buildHandler();

    await handler.finalizeSession(id);
    const firstEnd = readRow(store, id).completed_at_epoch as number;
    await Bun.sleep(2);

    store.reopenCompletedSession(id);
    await handler.finalizeSession(id);

    const row = readRow(store, id);
    expect(row.status).toBe('completed');
    expect(row.completed_at_epoch as number).toBeGreaterThan(firstEnd);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
