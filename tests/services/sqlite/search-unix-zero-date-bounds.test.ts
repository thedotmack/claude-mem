import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
let store: SessionStore;
afterEach(() => store?.close());
function setup() {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'project', 'prompt');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const ids: number[] = [];
  for (const epoch of [-100, 0, 100]) {
    const id = store.storeObservation('memory', 'project', { type: 'discovery', title: `row ${epoch}`, subtitle: null,
      narrative: 'file', facts: [], concepts: [], files_read: ['file.ts'], files_modified: [] }, 1).id;
    store.db.run('UPDATE observations SET created_at_epoch = ? WHERE id = ?', [epoch, id]);
    store.importSessionSummary({ memory_session_id: 'memory', project: 'project', request: `row ${epoch}`,
      investigated: null, learned: null, completed: null, next_steps: null, notes: null,
      files_read: '["file.ts"]', files_edited: '[]', prompt_number: 1, discovery_tokens: 0,
      created_at: new Date(epoch).toISOString(), created_at_epoch: epoch });
    const prompt = store.saveUserPrompt('content', ids.length + 1, `row ${epoch}`, sid);
    store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?', [epoch, prompt]);
    ids.push(id);
  }
  return new SessionSearch(store.db);
}
for (const start of [true, false]) {
  it(`honors numeric epoch zero as an inclusive ${start ? 'start' : 'end'} bound`, () => {
    const search = setup();
    const dateRange = start ? { start: 0 } : { end: 0 };
    const expected = start ? [0, 100] : [-100, 0];
    const options = { project: 'project', dateRange, orderBy: 'date_asc' as const };
    expect(search.searchObservations(undefined, options).map(row => row.created_at_epoch)).toEqual(expected);
    expect(search.searchSessions(undefined, options).map(row => row.created_at_epoch)).toEqual(expected);
    expect(search.searchUserPrompts(undefined, options).map(row => row.created_at_epoch)).toEqual(expected);
    expect(search.findByFile('file.ts', options).sessions.map(row => row.created_at_epoch)).toEqual(expected);
  });
}
