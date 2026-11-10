import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionStore.markSessionCompleted', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('leaves other sessions unaffected', () => {
    const id1 = store.createSDKSession('session-a', 'project', 'prompt');
    const id2 = store.createSDKSession('session-b', 'project', 'prompt');

    store.markSessionCompleted(id1);

    const row2 = store.db.prepare(
      'SELECT status, completed_at FROM sdk_sessions WHERE id = ?'
    ).get(id2) as { status: string; completed_at: string | null };

    expect(row2.status).toBe('active');
    expect(row2.completed_at).toBeNull();
  });

});
