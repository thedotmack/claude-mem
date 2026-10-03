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
  for (const [wanted, other] of [['src/my_file.ts', 'src/myXfile.ts'], ['src/100%.ts', 'src/100XYZ.ts'], ['C:\\repo\\my_file.ts', 'C:\\repo\\myXfile.ts']]) {
    it(`matches ${wanted} literally in file and files-filter search`, () => {
      store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
      const expected = seed(wanted, 'wanted'); seed(other, 'other');
      expect(search.findByFile(wanted, { project: 'project' }).observations.map(row => row.id)).toEqual([expected]);
      expect(search.searchObservations(undefined, { project: 'project', files: [wanted] }).map(row => row.id)).toEqual([expected]);
    });
  }
  for (const [wanted, other] of [['src/my_file.ts', 'src/myXfile.ts'], ['src/100%.ts', 'src/100XYZ.ts'], ['C:\\repo\\my_file.ts', 'C:\\repo\\myXfile.ts']]) {
    it(`filters ${wanted} literally during actual Chroma result hydration`, async () => {
      store = new SessionStore(':memory:');
      const expected = seed(wanted, 'wanted'); const changed = seed(wanted, 'modified', true);
      const unrelated = seed(other, 'other'); const ids = [unrelated, changed, expected];
      const vectorResults = { async queryChroma() { return { ids, distances: [0.1, 0.2, 0.3], metadatas: ids.map(id => ({ sqlite_id: id, doc_type: 'observation', created_at_epoch: Date.now(), project: 'project', memory_session_id: 'memory' })) }; } };
      const strategy = new ChromaSearchStrategy(vectorResults as any, store);
      const results = await strategy.search({ query: 'file', searchType: 'observations', project: 'project', files: wanted, orderBy: 'relevance' });
      expect(results.results.observations.map(row => row.id)).toEqual([changed, expected]);
      expect(store.getObservationsByIds(ids, { files: [wanted], orderBy: 'relevance' }).map(row => row.id)).toEqual([changed, expected]);
    });
  }
  it('still supports path substrings and Windows relative folder candidates', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    const id = seed('src\\my_folder\\file.ts', 'folder');
    expect(search.findByFile('file.ts', { project: 'project' }).observations.map(row => row.id)).toEqual([id]);
    expect(search.findByFile('C:\\repo\\src\\my_folder', { project: 'project', isFolder: true }).observations.map(row => row.id)).toEqual([id]);
  });
});
