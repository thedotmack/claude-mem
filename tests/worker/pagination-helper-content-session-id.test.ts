import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';

describe('PaginationHelper.getObservations content_session_id', () => {
  let store: SessionStore;
  let helper: PaginationHelper;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    helper = new PaginationHelper({ getSessionStore: () => store } as any);
  });

  afterEach(() => {
    store.close();
  });

  it('includes the owning session\'s content_session_id on each observation', () => {
    const sessionDbId = store.createSDKSession('content-abc', 'proj', 'hello');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-abc');
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'discovery', 'obs 1', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionDbId);

    const result = helper.getObservations(0, 20);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content_session_id).toBe('content-abc');
  });
});
