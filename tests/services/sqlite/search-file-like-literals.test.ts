import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';

describe('literal file names in search', () => {
  let store: SessionStore;
  afterEach(() => store?.close());
  function seed(file: string, suffix: string, modified = false): number {
    const sid = `memory-${suffix}`;
    const id = store.createSDKSession(`content-${suffix}`, 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(id, sid);
    return store.storeObservation(sid, 'project', { type: 'discovery', title: suffix, subtitle: null, narrative: 'file', facts: [], concepts: [], files_read: modified ? [] : [file], files_modified: modified ? [file] : [] }, 1).id;
  }
  const pathCases = [
    ['src/my_file.ts', 'src/myXfile.ts'],
    ['src/100%.ts', 'src/100XYZ.ts'],
    ['C:\\repo\\my_file.ts', 'C:\\repo\\myXfile.ts'],
    ['src\\a_10%\\file.ts', 'src\\ax10more\\file.ts', 'src/a_10%/file.ts'],
    ['src/a_10%/file.ts', 'src/ax10more/file.ts', 'src\\a_10%\\file.ts'],
    ['C:\\repo\\my_file.ts', 'C:\\repo\\myXfile.ts', 'C:/repo/my_file.ts'],
  ];
  for (const [wanted, other, query = wanted] of pathCases) {
    it(`matches ${wanted} literally with ${query} in file and files-filter search`, () => {
      store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
      const expected = seed(wanted, 'wanted'); seed(other, 'other');
      expect(search.findByFile(query, { project: 'project' }).observations.map(row => row.id)).toEqual([expected]);
      for (const text of [undefined, 'file']) {
        expect(search.searchObservations(text, { project: 'project', files: [query] }).map(row => row.id)).toEqual([expected]);
      }
    });
  }
  for (const [wanted, other, query = wanted] of pathCases) {
    it(`filters ${wanted} literally with ${query} during actual Chroma result hydration`, async () => {
      store = new SessionStore(':memory:');
      const expected = seed(wanted, 'wanted'); const changed = seed(wanted, 'modified', true);
      const unrelated = seed(other, 'other'); const ids = [unrelated, changed, expected];
      const vectorResults = { async queryChroma() { return { ids, distances: [0.1, 0.2, 0.3], metadatas: ids.map(id => ({ sqlite_id: id, doc_type: 'observation', created_at_epoch: Date.now(), project: 'project', memory_session_id: 'memory' })) }; } };
      const strategy = new ChromaSearchStrategy(vectorResults as any, store);
      const results = await strategy.search({ query: 'file', searchType: 'observations', project: 'project', files: query, orderBy: 'relevance' });
      expect(results.results.observations.map(row => row.id)).toEqual([changed, expected]);
      expect(store.getObservationsByIds(ids, { files: [query], orderBy: 'relevance' }).map(row => row.id)).toEqual([changed, expected]);
    });
  }
  it('keeps array filters disjunctive and filters read/modified paths before pagination', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    const read = seed('src\\a_10%\\file.ts', 'read');
    const modified = seed('src/second.ts', 'modified', true);
    const unrelated = seed('src\\ax10more\\file.ts', 'unrelated');
    store.db.run('UPDATE observations SET created_at_epoch = id');
    const files = ['src/a_10%/file.ts', 'src\\second.ts'];
    expect(search.searchObservations(undefined, { project: 'project', files, limit: 1 }).map(row => row.id)).toEqual([modified]);
    expect(search.searchObservations(undefined, { project: 'project', files, limit: 1, offset: 1 }).map(row => row.id)).toEqual([read]);
    expect(search.searchObservations(undefined, { project: 'other-project', files }).map(row => row.id)).toEqual([]);
    expect(store.getObservationsByIds([unrelated, modified, read], { project: 'project', files, limit: 1, orderBy: 'relevance' }).map(row => row.id)).toEqual([modified]);
    expect(store.getObservationsByIds([unrelated, modified, read], { project: 'project', files, orderBy: 'relevance' }).map(row => row.id)).toEqual([modified, read]);
    expect(store.getObservationsByIds([unrelated, modified, read], { project: 'other-project', files }).map(row => row.id)).toEqual([]);
  });
});
