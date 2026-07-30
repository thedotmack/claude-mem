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

  it('filters observations by contentSessionId', () => {
    const sessionA = store.createSDKSession('content-a', 'proj', 'a');
    const sessionB = store.createSDKSession('content-b', 'proj', 'b');
    store.ensureMemorySessionIdRegistered(sessionA, 'mem-a');
    store.ensureMemorySessionIdRegistered(sessionB, 'mem-b');
    for (const [sessionDbId, title] of [[sessionA, 'obs-a'], [sessionB, 'obs-b']] as const) {
      store.db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
        SELECT memory_session_id, 'proj', 'discovery', ?, '2026-07-20T00:00:00.000Z', 1752969600000
        FROM sdk_sessions WHERE id = ?
      `).run(title, sessionDbId);
    }

    const result = helper.getObservations(0, 20, undefined, undefined, 'content-a');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('obs-a');
  });

  it('filters summaries and prompts by contentSessionId', () => {
    const sessionA = store.createSDKSession('content-a', 'proj', 'a');
    const sessionB = store.createSDKSession('content-b', 'proj', 'b');
    store.ensureMemorySessionIdRegistered(sessionA, 'mem-a2');
    store.ensureMemorySessionIdRegistered(sessionB, 'mem-b2');
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'summary-a', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionA);
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      SELECT memory_session_id, 'proj', 'summary-b', '2026-07-20T00:00:00.000Z', 1752969600000
      FROM sdk_sessions WHERE id = ?
    `).run(sessionB);
    store.db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'content-a', 1, 'prompt-a', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run(sessionA);
    store.db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'content-b', 1, 'prompt-b', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run(sessionB);

    const summaries = helper.getSummaries(0, 20, undefined, undefined, 'content-a');
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0].request).toBe('summary-a');

    const prompts = helper.getPrompts(0, 20, undefined, undefined, 'content-a');
    expect(prompts.items).toHaveLength(1);
    expect(prompts.items[0].prompt_text).toBe('prompt-a');
  });
});
