import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
let store: SessionStore;
afterEach(() => store?.close());
for (const column of ['files_read', 'files_edited']) {
  it(`searches summary ${column} with the public files filter`, () => {
    store = new SessionStore(':memory:');
    const session = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(session, 'memory');
    const id = store.importSessionSummary({ memory_session_id: 'memory', project: 'project', request: 'summary',
      investigated: null, learned: null, completed: null, next_steps: null, notes: null,
      files_read: '[]', files_edited: '[]', [column]: '["src/file.ts"]', prompt_number: 1,
      discovery_tokens: 0, created_at: new Date(100).toISOString(), created_at_epoch: 100 }).id;
    const search = new SessionSearch(store.db);
    expect(search.searchSessions(undefined, { project: 'project', files: ['file.ts'] }).map(row => row.id)).toEqual([id]);
    expect(search.searchSessions('summary', { project: 'project', files: ['file.ts'] }).map(row => row.id)).toEqual([id]);
  });
}
