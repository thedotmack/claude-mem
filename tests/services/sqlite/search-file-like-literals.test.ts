import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

describe('literal file names in search', () => {
  let store: SessionStore;
  afterEach(() => store?.close());
  function seed(file: string, suffix: string): number {
    const sid = `memory-${suffix}`;
    const id = store.createSDKSession(`content-${suffix}`, 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(id, sid);
    return store.storeObservation(sid, 'project', { type: 'discovery', title: suffix, subtitle: null, narrative: 'file', facts: [], concepts: [], files_read: [file], files_modified: [] }, 1).id;
  }
  for (const [wanted, other] of [['src/my_file.ts', 'src/myXfile.ts'], ['src/100%.ts', 'src/100XYZ.ts'], ['C:\\repo\\my_file.ts', 'C:\\repo\\myXfile.ts']]) {
    it(`matches ${wanted} literally in file and files-filter search`, () => {
      store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
      const expected = seed(wanted, 'wanted'); seed(other, 'other');
      expect(search.findByFile(wanted, { project: 'project' }).observations.map(row => row.id)).toEqual([expected]);
      expect(search.searchObservations(undefined, { project: 'project', files: [wanted] }).map(row => row.id)).toEqual([expected]);
    });
  }
  it('still supports path substrings and Windows relative folder candidates', () => {
    store = new SessionStore(':memory:'); const search = new SessionSearch(store.db);
    const id = seed('src\\my_folder\\file.ts', 'folder');
    expect(search.findByFile('file.ts', { project: 'project' }).observations.map(row => row.id)).toEqual([id]);
    expect(search.findByFile('C:\\repo\\src\\my_folder', { project: 'project', isFolder: true }).observations.map(row => row.id)).toEqual([id]);
  });
});
