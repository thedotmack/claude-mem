import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

let store: SessionStore;
afterEach(() => store?.close());

function seed(epoch: number) {
  const sid = `ordered-${epoch}`;
  const id = store.createSDKSession(`content-${epoch}`, 'ordered-project', 'prompt');
  store.ensureMemorySessionIdRegistered(id, sid);
  const observation = store.storeObservation(sid, 'ordered-project', {
    type: 'discovery', title: sid, subtitle: null, narrative: sid,
    facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
  }, 1, 0, epoch).id;
  const summary = store.importSessionSummary({
    memory_session_id: sid, project: 'ordered-project', request: sid,
    investigated: null, learned: null, completed: null, next_steps: null,
    notes: null, files_read: JSON.stringify(['src/file.ts']), files_edited: null,
    prompt_number: 1, discovery_tokens: 0,
    created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
  }).id;
  return { observation, summary };
}

it.each([false, true])('paginates file observations and summaries in requested ascending order (folder=%s)', async (isFolder) => {
  store = new SessionStore(':memory:');
  const search = new SessionSearch(store.db);
  const first = seed(1000);
  seed(2000);
  const last = seed(3000);
  const orchestrator = new SearchOrchestrator(search, store, null);
  const path = isFolder ? 'src' : 'src/file.ts';
  const options = { project: 'ordered-project', isFolder, orderBy: 'date_asc', limit: 1 };
  const page = await orchestrator.findByFile(path, options);
  expect(page.observations.map(row => row.id)).toEqual([first.observation]);
  expect(page.sessions.map(row => row.id)).toEqual([first.summary]);
  const final = await orchestrator.findByFile(path, { ...options, offset: 2 });
  expect(final.observations.map(row => row.id)).toEqual([last.observation]);
  expect(final.sessions.map(row => row.id)).toEqual([last.summary]);
  const descending = await orchestrator.findByFile(path, { ...options, orderBy: 'date_desc' });
  expect(descending.observations.map(row => row.id)).toEqual([last.observation]);
  expect(descending.sessions.map(row => row.id)).toEqual([last.summary]);
});
