import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
let store: SessionStore;
afterEach(() => store?.close());
for (const concepts of ['缓存', '"缓存"']) {
  it(`finds a legacy single concept stored as ${concepts}`, () => {
    store = new SessionStore(':memory:');
    const sid = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sid, 'memory');
    const id = store.storeObservation('memory', 'project', { type: 'discovery', title: 'legacy', subtitle: null,
      narrative: 'cache', facts: [], concepts: ['缓存'], files_read: [], files_modified: [] }, 1).id;
    store.db.run('UPDATE observations SET concepts = ? WHERE id = ?', [concepts, id]);
    const search = new SessionSearch(store.db);
    expect(search.findByConcept('缓存', { project: 'project' }).map(row => row.id)).toEqual([id]);
    expect(search.searchObservations('cache', { project: 'project', concepts: ['缓存'] }).map(row => row.id)).toEqual([id]);
  });
}
it('keeps array string concepts and rejects non-string array members', () => {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'project', 'prompt');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const id = store.storeObservation('memory', 'project', { type: 'discovery', title: 'array', subtitle: null,
    narrative: 'cache', facts: [], concepts: ['缓存'], files_read: [], files_modified: [] }, 1).id;
  store.db.run('UPDATE observations SET concepts = ? WHERE id = ?', ['[null,{"topic":"cache"},"缓存"]', id]);
  const search = new SessionSearch(store.db);
  expect(search.findByConcept('缓存', { project: 'project' }).map(row => row.id)).toEqual([id]);
  expect(search.findByConcept('{"topic":"cache"}', { project: 'project' })).toEqual([]);
});
