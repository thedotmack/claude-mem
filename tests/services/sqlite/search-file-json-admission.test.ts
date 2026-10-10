import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

let store: SessionStore;
afterEach(() => store?.close());
function setup() {
  store = new SessionStore(':memory:');
  const session = store.createSDKSession('content', 'project', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'memory');
  const id = store.storeObservation('memory', 'project', {
    type: 'discovery', title: 'wanted', subtitle: null, narrative: 'file', facts: [],
    concepts: [], files_read: ['src/wanted.ts'], files_modified: [],
  }, 1).id;
  return { id, search: new SessionSearch(store.db) };
}
it('searches valid files despite an invalid neighboring JSON column', () => {
  const { id, search } = setup();
  store.db.run('UPDATE observations SET files_read = ?, files_modified = ? WHERE id = ?', ['broken JSON', '["src/wanted.ts"]', id]);
  expect(search.findByFile('wanted.ts', { project: 'project' }).observations.map(row => row.id)).toEqual([id]);
  expect(search.searchObservations(undefined, { project: 'project', files: ['wanted.ts'] }).map(row => row.id)).toEqual([id]);
});
it('does not mistake an object property for a recorded file', () => {
  const { id, search } = setup();
  store.db.run('UPDATE observations SET files_read = ? WHERE id = ?', ['{"message":"src/wanted.ts"}', id]);
  expect(search.findByFile('wanted.ts', { project: 'project' }).observations).toEqual([]);
});
it('keeps direct children after non-string entries in a file array', () => {
  const { id, search } = setup();
  store.db.run('UPDATE observations SET files_read = ? WHERE id = ?', ['[null, "src/wanted.ts"]', id]);
  expect(search.findByFile('src', { project: 'project', isFolder: true }).observations.map(row => row.id)).toEqual([id]);
});
it('handles invalid summary columns without losing the other file list', () => {
  const { search } = setup();
  const id = store.importSessionSummary({ memory_session_id: 'memory', project: 'project',
    request: 'summary', investigated: null, learned: null, completed: null, next_steps: null,
    notes: null, files_read: 'broken JSON', files_edited: '[null,"src/wanted.ts"]',
    prompt_number: 1, discovery_tokens: 0, created_at: new Date(100).toISOString(), created_at_epoch: 100 }).id;
  expect(search.findByFile('src', { project: 'project', isFolder: true }).sessions.map(row => row.id)).toEqual([id]);
});
