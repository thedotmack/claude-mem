import { afterEach, expect, test } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

let store: SessionStore;
afterEach(() => store?.close());

function seed(file: string, label: string, modified = false, project = 'project') {
  const memory = `memory-${label}`;
  const session = store.createSDKSession(`content-${label}`, project, 'synthetic prompt');
  store.ensureMemorySessionIdRegistered(session, memory);
  const observation = store.storeObservation(memory, project, {
    type: 'discovery', title: label, subtitle: null, narrative: 'synthetic file evidence',
    facts: [], concepts: [], files_read: modified ? [] : [file], files_modified: modified ? [file] : [],
  }, 1).id;
  const summary = store.importSessionSummary({
    memory_session_id: memory, project, request: label, investigated: null,
    learned: null, completed: null, next_steps: null, notes: null,
    files_read: modified ? null : JSON.stringify([file]),
    files_edited: modified ? JSON.stringify([file]) : null,
    prompt_number: 1, discovery_tokens: 0,
    created_at: '2026-10-30T00:00:00Z', created_at_epoch: 1793318400000,
  }).id;
  return { observation, summary };
}

for (const query of ['C:/repo/src/feature', 'C:\\repo\\src\\feature', 'src/feature', 'src\\feature']) {
  test(`folder lookup preserves relative backslash evidence: ${JSON.stringify(query)}`, async () => {
    store = new SessionStore(':memory:');
    const read = seed('src\\feature\\main.ts', 'read');
    const edited = seed('src\\feature\\edit.ts', 'edited', true);
    seed('src\\feature\\nested\\deep.ts', 'nested');
    seed('src\\feature-old\\other.ts', 'sibling');
    seed('src\\feature\\other-project.ts', 'foreign', false, 'other');
    const orchestrator = new SearchOrchestrator(new SessionSearch(store.db), store, null);
    const result = await orchestrator.findByFile(query, { project: 'project', isFolder: true });
    expect(result.observations.map(row => row.id).sort((a, b) => a - b)).toEqual([read.observation, edited.observation]);
    expect(result.sessions.map(row => row.id).sort((a, b) => a - b)).toEqual([read.summary, edited.summary]);
    expect(result.usedChroma).toBe(false);
  });
}

test('folder candidates keep percent, underscore, quotes and backslashes literal', async () => {
  store = new SessionStore(':memory:');
  const wanted = seed('src\\a_10%"quoted\\main.ts', 'wanted', true);
  seed('src\\aX10more"quoted\\other.ts', 'wildcard');
  seed('src\\a_10%"quoted\\nested\\deep.ts', 'nested');
  const orchestrator = new SearchOrchestrator(new SessionSearch(store.db), store, null);
  for (const query of ['C:/repo/src/a_10%"quoted', 'C:\\repo\\src\\a_10%"quoted', 'src/a_10%"quoted', 'src\\a_10%"quoted']) {
    const result = await orchestrator.findByFile(query, { project: 'project', isFolder: true });
    expect(result.observations.map(row => row.id)).toEqual([wanted.observation]);
    expect(result.sessions.map(row => row.id)).toEqual([wanted.summary]);
    const next = await orchestrator.findByFile(query, { project: 'project', isFolder: true, limit: 1, offset: 1 });
    expect(next.observations).toEqual([]);
    expect(next.sessions).toEqual([]);
  }
});
