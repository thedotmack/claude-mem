import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';

let store: SessionStore;
afterEach(() => store?.close());
function seed() {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('zero-content', 'zero-project', 'prompt');
  store.ensureMemorySessionIdRegistered(sid, 'zero-memory');
  for (const epoch of [-100, 100]) {
    store.storeObservation('zero-memory', 'zero-project', {
      type: 'discovery', title: 'epoch ' + epoch, subtitle: null, narrative: 'synthetic',
      facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
    }, 1, 0, epoch);
    store.storeSummary('zero-memory', 'zero-project', {
      request: 'epoch ' + epoch, investigated: null, learned: null, completed: null,
      next_steps: null, notes: null, files_read: ['src/file.ts'],
    }, 1, 0, epoch);
    store.db.prepare(`INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sid, 'zero-content', epoch, 'synthetic', new Date(epoch).toISOString(), epoch);
  }
}
const epochs = (rows: Array<{ created_at_epoch: number }>) => rows.map(row => row.created_at_epoch);
for (const boundary of ['start', 'end'] as const) {
  it(`honors numeric epoch zero as a SQLite ${boundary} bound in every category and file lookup`, () => {
    seed();
    const search = new SessionSearch(store.db);
    const options = { project: 'zero-project', dateRange: { [boundary]: 0 } };
    const expected = [boundary === 'start' ? 100 : -100];
    expect(epochs(search.searchObservations(undefined, options))).toEqual(expected);
    expect(epochs(search.searchSessions(undefined, options))).toEqual(expected);
    expect(epochs(search.searchUserPrompts(undefined, options))).toEqual(expected);
    const files = search.findByFile('src/file.ts', options);
    expect(epochs(files.observations)).toEqual(expected);
    expect(epochs(files.sessions)).toEqual(expected);
  });

  for (const bound of [0, '1970-01-01T00:00:00.000Z']) {
    it(`honors ${JSON.stringify(bound)} as a Chroma ${boundary} bound`, async () => {
      seed();
      const rows = store.getObservationsByIds([1, 2]);
      const chroma = { queryChroma: async () => ({ ids: rows.map(row => row.id),
        metadatas: rows.map(row => ({ sqlite_id: row.id, doc_type: 'observation',
          project: row.project, created_at_epoch: row.created_at_epoch })), distances: [0.1, 0.2] }) };
      const strategy = new ChromaSearchStrategy(chroma as any, store);
      const result = await strategy.search({ query: 'synthetic', searchType: 'observations',
        project: 'zero-project', dateRange: { [boundary]: bound } });
      expect(epochs(result.results.observations)).toEqual([boundary === 'start' ? 100 : -100]);
    });
  }
}
it('preserves numeric zero through public search argument aliases', async () => {
  seed();
  const manager = new SearchManager(new SessionSearch(store.db), store, null as any,
    new FormattingService(), new TimelineService());
  for (const key of ['dateStart', 'date_start', 'date_from', 'dateEnd', 'date_end', 'date_to']) {
    const result = await manager.search({ query: 'synthetic', type: 'observations',
      project: 'zero-project', format: 'json', [key]: 0 });
    const start = key.includes('Start') || key.endsWith('start') || key.endsWith('from');
    expect(epochs(result.observations)).toEqual([start ? 100 : -100]);
  }
});
