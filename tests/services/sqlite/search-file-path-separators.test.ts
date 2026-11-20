import { afterEach, expect, test } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

let store: SessionStore;
afterEach(() => store?.close());

function seed(file: string, suffix: string, modified = false) {
  const memory = `memory-${suffix}`;
  const session = store.createSDKSession(`content-${suffix}`, 'project', 'prompt');
  store.ensureMemorySessionIdRegistered(session, memory);
  const observation = store.storeObservation(memory, 'project', {
    type: 'discovery', title: suffix, subtitle: null, narrative: suffix,
    facts: [], concepts: [], files_read: modified ? [] : [file], files_modified: modified ? [file] : [],
  }, 1).id;
  const summary = store.importSessionSummary({
    memory_session_id: memory, project: 'project', request: suffix,
    investigated: null, learned: null, completed: null, next_steps: null, notes: null,
    files_read: modified ? null : JSON.stringify([file]), files_edited: modified ? JSON.stringify([file]) : null,
    prompt_number: 1, discovery_tokens: 0, created_at: '2026-10-30T00:00:00Z', created_at_epoch: 1793318400000,
  }).id;
  return { observation, summary };
}

for (const [stored, query] of [
  ['src\\feature\\main.ts', 'src/feature/main.ts'],
  ['src/feature/main.ts', 'src\\feature\\main.ts'],
  ['C:\\repo\\src\\main.ts', 'C:/repo/src/main.ts'],
  ['C:/repo/src/main.ts', 'C:\\repo\\src\\main.ts'],
]) {
  test(`file search matches equivalent path separators: ${JSON.stringify(stored)} -> ${JSON.stringify(query)}`, async () => {
    store = new SessionStore(':memory:');
    const wanted = seed(stored, 'wanted');
    const search = new SessionSearch(store.db);
    const orchestrator = new SearchOrchestrator(search, store, null);
    const result = await orchestrator.findByFile(query, { project: 'project' });
    expect(result.observations.map(row => row.id)).toEqual([wanted.observation]);
    expect(result.sessions.map(row => row.id)).toEqual([wanted.summary]);
  });
}

test('file path variants preserve literal wildcards, edited files and pagination', async () => {
  store = new SessionStore(':memory:');
  const wanted = seed('src\\a_10%\\main.ts', 'wanted', true);
  seed('src\\ax10more\\main.ts', 'different', true);
  const orchestrator = new SearchOrchestrator(new SessionSearch(store.db), store, null);
  const result = await orchestrator.findByFile('src/a_10%/main.ts', { project: 'project', limit: '1' });
  expect(result.observations.map(row => row.id)).toEqual([wanted.observation]);
  expect(result.sessions.map(row => row.id)).toEqual([wanted.summary]);
  expect(await orchestrator.findByFile('src/a_10%/main.ts', { project: 'project', limit: '1', offset: '1' })).toMatchObject({ observations: [], sessions: [] });
});
