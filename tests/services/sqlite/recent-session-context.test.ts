import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('recent session context selection', () => {
  let store: SessionStore;
  const epoch = Date.UTC(2026, 0, 1);

  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => store.close());

  function session(name: string, order: number, project = 'app', platform = 'claude-code', summaries = 0) {
    const id = store.createSDKSession(name, project, `request ${name}`, undefined, platform);
    const memory = store.ensureMemorySessionIdRegistered(id, `memory-${name}`);
    store.db.run('UPDATE sdk_sessions SET started_at = ?, started_at_epoch = ? WHERE id = ?',
      [new Date(epoch + order).toISOString(), epoch + order, id]);
    for (let i = 0; i < summaries; i++) store.storeSummary(memory, project, {
      request: `summary ${name} ${i}`, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, i + 1, 0, epoch + order + i);
    return id;
  }

  it('returns each selected session once despite multiple summaries, oldest selected first', () => {
    session('old', 1, 'app', 'claude-code', 3);
    session('second', 2, 'app', 'claude-code', 5);
    session('third', 3);
    session('newest', 4, 'app', 'claude-code', 2);
    expect(store.getRecentSessionsWithStatus('app', 3).map(row => [row.memory_session_id, row.has_summary]))
      .toEqual([['memory-second', 1], ['memory-third', 0], ['memory-newest', 1]]);
  });

  it('filters project spelling and platform before choosing the newest sessions', () => {
    session('old', 1);
    session('selected', 2, 'APP');
    session('other-platform', 3, 'app', 'codex', 2);
    session('other-project', 4, 'elsewhere');
    store.createSDKSession('no-memory', 'app', 'pending');
    expect(store.getRecentSessionsWithStatus('App', 1, 'Claude Code').map(row => row.memory_session_id))
      .toEqual(['memory-selected']);
  });

  it('keeps status, prompt and source timestamp fields unchanged', () => {
    const id = session('done', 7, 'app', 'claude-code', 2);
    store.markSessionCompleted(id);
    expect(store.getRecentSessionsWithStatus('app', 1)).toEqual([{
      memory_session_id: 'memory-done', status: 'completed', started_at: new Date(epoch + 7).toISOString(),
      started_at_epoch: epoch + 7, user_prompt: 'request done', has_summary: 1,
    }]);
    expect(store.getRecentSessionsWithStatus('absent')).toEqual([]);
  });

  it('does not group the project history before applying the recent-session limit', () => {
    session('saved', 1, 'app', 'claude-code', 3);
    const prepare = store.db.prepare;
    let query = '';
    try {
      store.db.prepare = ((...args: Parameters<typeof prepare>) => {
        query = args[0];
        return prepare.apply(store.db, args);
      }) as typeof prepare;
      store.getRecentSessionsWithStatus('app', 3);
    } finally {
      store.db.prepare = prepare;
    }
    const plan = (store.db.query(`EXPLAIN QUERY PLAN ${query}`).all('app', 3) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
    expect(plan).not.toContain('GROUP BY');
    expect(plan).toContain('USING COVERING INDEX');
  });
});
