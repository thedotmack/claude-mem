import { expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

for (const prefix of ['/home/project', 'C:\\project']) {
  it(`finds absolute tool evidence from a relative folder query under ${prefix}`, () => {
    const store = new SessionStore(':memory:');
    try {
      const sid = store.createSDKSession('content', 'project', 'prompt');
      store.ensureMemorySessionIdRegistered(sid, 'memory');
      const wanted = store.storeObservation('memory', 'project', { type: 'discovery', title: 'wanted', subtitle: null,
        narrative: 'files', facts: [], concepts: [], files_read: [`${prefix}/src/utils/file.ts`], files_modified: [] }, 1).id;
      for (const file of [`${prefix}/src/utils/nested/file.ts`, `${prefix}/other/utils/file.ts`]) {
        store.storeObservation('memory', 'project', { type: 'discovery', title: file, subtitle: null,
          narrative: 'files', facts: [], concepts: [], files_read: [file], files_modified: [] }, 1);
      }
      expect(new SessionSearch(store.db).findByFile('src/utils', { project: 'project', isFolder: true }).observations.map(row => row.id)).toEqual([wanted]);
    } finally { store.close(); }
  });
}
