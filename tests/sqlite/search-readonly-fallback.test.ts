import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
let store: SessionStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});
for (const [title, query] of [['Éclair', 'éclair'], ['foo bar', 'foo-bar']]) {
  it(`uses readable indexes for ${query} when FTS creation is forbidden`, () => {
    store = new SessionStore(':memory:');
    const sid = store.createSDKSession(`readable-${query}`, 'app', 'prompt');
    store.updateMemorySessionId(sid, `memory-${query}`);
    store.storeObservation(`memory-${query}`, 'app', {
      type: 'discovery', title, subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.storeSummary(`memory-${query}`, 'app', {
      request: title, investigated: null, learned: null, completed: null,
      next_steps: null, notes: null,
    });
    // Initialize real indexes while writes are permitted, then reopen search
    // on the same read-only connection; no mock of FTS availability.
    new SessionSearch(store.db);
    store.db.run('PRAGMA query_only=1');
    const search = new SessionSearch(store.db);
    expect(search.searchObservations(query, { project: 'app' })).toHaveLength(1);
    expect(search.searchSessions(query, { project: 'app' })).toHaveLength(1);
    expect(search.searchObservations(query, { project: 'unrelated' })).toEqual([]);
    expect(search.searchSessions(query, { project: 'app', offset: 1 })).toEqual([]);
  });
}
it('reads Latin text from a query-only connection when the FTS probe cannot write', () => {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content-readonly', 'app', 'prompt');
  store.updateMemorySessionId(sid, 'memory-readonly');
  store.storeObservation(
    'memory-readonly',
    'app',
    {
      type: 'discovery',
      title: 'fallback rescue',
      subtitle: null,
      narrative: 'rescue native SQLite',
      facts: [],
      concepts: [],
      files_read: [],
      files_modified: [],
    },
    1
  );
  store.storeSummary('memory-readonly', 'app', {
    request: 'rescue request',
    investigated: null,
    learned: null,
    completed: null,
    next_steps: null,
    notes: null,
  });
  store.db.run('PRAGMA query_only=1');
  const search = new SessionSearch(store.db);
  expect(search.searchObservations('rescue', { project: 'app' })).toHaveLength(1);
  expect(search.searchSessions('rescue', { project: 'app' })).toHaveLength(1);
  expect(search.searchObservations('absent', { project: 'app' })).toEqual([]);
  expect(search.searchObservations('rescue', { project: 'unrelated' })).toEqual([]);
});

it('preserves pagination and LIKE-literal safety in the read-only fallback', () => {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content-page', 'app', 'prompt');
  store.updateMemorySessionId(sid, 'memory-page');
  const observation = (title: string, epoch: number) =>
    store!.storeObservation(
      'memory-page',
      'app',
      {
        type: 'discovery',
        title,
        subtitle: null,
        narrative: null,
        facts: [],
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      1,
      0,
      epoch
    );
  const older = observation('rescue old', 1000);
  observation('rescue new', 2000);
  const literal = observation('literal_100%', 3000);
  observation('literalX100abc', 4000);
  store.db.run('PRAGMA query_only=1');
  const search = new SessionSearch(store.db);
  expect(
    search
      .searchObservations('rescue', { project: 'app', limit: 1, offset: 1 })
      .map((row) => row.id)
  ).toEqual([older.id]);
  expect(
    search.searchObservations('literal_100%', { project: 'app' }).map((row) => row.id)
  ).toEqual([literal.id]);
});
