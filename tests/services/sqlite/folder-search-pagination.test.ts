import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

describe('folder pages count direct children', () => {
  let store: SessionStore;
  afterEach(() => store?.close());
  function seed(path: string, epoch: number): { observation: number; summary: number } {
    const sid = `memory-${epoch}`;
    const sdkId = store.createSDKSession(`content-${epoch}`, 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, sid);
    const observation = store.storeObservation(sid, 'project', { type: 'discovery', title: sid, subtitle: null, narrative: sid, facts: [], concepts: [], files_read: [path], files_modified: [] }, 1, 0, epoch).id;
    const summary = store.importSessionSummary({ memory_session_id: sid, project: 'project', request: sid, investigated: null, learned: null, completed: null, next_steps: null, notes: null, files_read: JSON.stringify([path]), files_edited: null, prompt_number: 1, discovery_tokens: 0, created_at: new Date(epoch).toISOString(), created_at_epoch: epoch }).id;
    return { observation, summary };
  }
  for (const withChroma of [false, true]) {
    it(`forwards URL pagination through actual ${withChroma ? 'hybrid' : 'SQLite'} orchestration`, async () => {
      store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
      const second = seed('src/second.ts', 100); seed('src/nested/file.ts', 101); seed('src/first.ts', 102);
      const chroma = withChroma ? { queryChroma: async () => ({ ids: [], distances: [], metadatas: [] }) } : null;
      const orchestrator = new SearchOrchestrator(search, store, chroma as any);
      const page = await orchestrator.findByFile('src', { project: 'project', isFolder: true, limit: '1', offset: '1' });
      expect(page.observations.map(row => row.id)).toEqual([second.observation]);
      expect(page.sessions.map(row => row.id)).toEqual([second.summary]);
    });
  }
  it('stops the native SQLite iterator as soon as a numeric-string page is filled', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    for (let i = 1; i <= 10; i++) seed(`src/nested/n${i}.ts`, 100 + i);
    const wanted = seed('src/direct.ts', 200);
    let yielded = 0;
    const prepare = store.db.prepare.bind(store.db);
    const spy = spyOn(store.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes('json_each') && sql.includes('SELECT o.*')) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* (...params: any[]) {
          for (const row of iterate(...params)) { yielded++; yield row; }
        } as typeof statement.iterate;
      }
      return statement;
    });
    try {
      const results = search.findByFile('src', { project: 'project', isFolder: true, limit: '1' as unknown as number });
      expect(results.observations.map(row => row.id)).toEqual([wanted.observation]);
      expect(yielded).toBe(1);
      yielded = 0;
      expect(search.findByFile('src', { project: 'project', isFolder: true, limit: 0 })).toEqual({ observations: [], sessions: [] });
      expect(yielded).toBe(0);
      expect(() => search.findByFile('src', { project: 'project', isFolder: true, limit: -1 })).toThrow('non-negative integer');
    } finally { spy.mockRestore(); }
  });
  it('finds direct children even after more than three pages of nested candidates', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    const wanted = seed('src/direct.ts', 100);
    for (let i = 1; i <= 5; i++) seed(`src/nested/n${i}.ts`, 100 + i);
    const result = search.findByFile('src', { project: 'project', isFolder: true, limit: 1 });
    expect(result.observations.map(row => row.id)).toEqual([wanted.observation]);
    expect(result.sessions.map(row => row.id)).toEqual([wanted.summary]);
  });
  it('applies offset to the matching children rather than the nested candidates', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    const second = seed('src/second.ts', 100); seed('src/nested/file.ts', 101); const first = seed('src/first.ts', 102);
    const page1 = search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: 0 });
    const page2 = search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: 1 });
    expect(page1.observations.map(row => row.id)).toEqual([first.observation]);
    expect(page2.observations.map(row => row.id)).toEqual([second.observation]);
    expect(page2.sessions.map(row => row.id)).toEqual([second.summary]);
    expect(search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: '1' as unknown as number })).toEqual(page2);
    expect(search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: -1 })).toEqual(page1);
    expect(() => search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: 0.5 })).toThrow('offset must be an integer');
    expect(() => search.findByFile('src', { project: 'project', isFolder: true, limit: 1.5 })).toThrow('limit must be a non-negative integer');
    expect(search.findByFile('src', { project: 'project', isFolder: true, limit: 1, offset: 2 })).toEqual({ observations: [], sessions: [] });
  });
  it('releases both folder queries once their page is full', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    seed('src/first.ts', 100); seed('src/second.ts', 101);
    store.db.run('CREATE TABLE release_probe (x)');
    const page = search.findByFile('src', { project: 'project', isFolder: true, limit: 1 });
    expect(page.observations).toHaveLength(1);
    expect(page.sessions).toHaveLength(1);
    // bun:sqlite keeps an iterate() cursor open after an early break until GC,
    // and SQLite refuses DROP TABLE while any statement is still reading.
    expect(() => store.db.run('DROP TABLE release_probe')).not.toThrow();
  });
});
