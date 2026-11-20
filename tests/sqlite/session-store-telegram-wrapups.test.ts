import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore Telegram wrap-ups', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('finds a session by platform and content id without inserting an unknown session', () => {
    const sessionDbId = store.createSDKSession(
      'content-wrapup-lookup',
      'project-a',
      'prompt',
      undefined,
      'codex',
    );
    const before = store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get() as { count: number };

    expect(store.findSessionDbIdByContentSessionId('content-wrapup-lookup', 'codex')).toBe(sessionDbId);
    expect(store.findSessionDbIdByContentSessionId('content-wrapup-lookup', 'claude')).toBeNull();
    expect(store.findSessionDbIdByContentSessionId('unknown-content-session', 'codex')).toBeNull();

    const after = store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get() as { count: number };
    expect(after.count).toBe(before.count);
  });
});
