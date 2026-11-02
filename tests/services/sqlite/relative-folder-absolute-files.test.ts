import { expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

for (const prefix of ['/home/project', 'C:\\project', 'C:/project']) {
  it(`finds absolute tool evidence from a relative folder query under ${prefix}`, () => {
    const store = new SessionStore(':memory:');
    try {
      const sid = store.createSDKSession('content', 'project', 'prompt');
      store.ensureMemorySessionIdRegistered(sid, 'memory');
      const wanted = store.storeObservation('memory', 'project', { type: 'discovery', title: 'wanted', subtitle: null,
        narrative: 'files', facts: [], concepts: [], files_read: [prefix.includes('\\') ? `${prefix}\\src\\utils\\file.ts` : `${prefix}/src/utils/file.ts`], files_modified: [] }, 1).id;
      for (const file of [`${prefix}/src/utils/nested/file.ts`, `${prefix}/other/utils/file.ts`]) {
        store.storeObservation('memory', 'project', { type: 'discovery', title: file, subtitle: null,
          narrative: 'files', facts: [], concepts: [], files_read: [file], files_modified: [] }, 1);
      }
      const edited = store.storeObservation('memory', 'project', { type: 'discovery', title: 'edited', subtitle: null,
        narrative: 'files', facts: [], concepts: [], files_read: [], files_modified: ['C:\\project\\src\\utils\\edited.ts'] }, 1).id;
      const summary = store.importSessionSummary({ memory_session_id: 'memory', project: 'project', request: 'summary', investigated: null, learned: null, completed: null, next_steps: null, notes: null, files_read: null, files_edited: JSON.stringify(['C:\\project\\src\\utils\\edited.ts']), prompt_number: 1, discovery_tokens: 0, created_at: new Date().toISOString(), created_at_epoch: Date.now() }).id;
      const search = new SessionSearch(store.db);
      expect(search.findByFile('src/utils', { project: 'project', isFolder: true }).sessions.map(row => row.id)).toEqual([summary]);
      expect(new SessionSearch(store.db).findByFile('src/utils', { project: 'project', isFolder: true }).observations.map(row => row.id)).toEqual([edited, wanted]);
    } finally { store.close(); }
  });
}
