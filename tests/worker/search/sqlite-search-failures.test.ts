import { describe, expect, it } from 'bun:test';
import { SQLiteSearchStrategy } from '../../../src/services/worker/search/strategies/SQLiteSearchStrategy.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

describe('SQLite search failures', () => {
  it('propagates a database failure instead of reporting a successful empty result', async () => {
    const failure = new Error('database is locked');
    const strategy = new SQLiteSearchStrategy({
      searchObservations() { throw failure; },
      searchSessions: () => [], searchUserPrompts: () => [],
    } as any);
    let caught: unknown;
    try { await strategy.search({ project: 'app', searchType: 'observations' }); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });

  it('does not replace a saved corpus when the source SQLite connection has closed', async () => {
    const store = new SessionStore(':memory:');
    const search = new SessionSearch(store.db);
    const original = { name: 'saved-knowledge', observations: [{ id: 1, title: 'Existing knowledge' }] };
    let saved: unknown = original;
    const builder = new CorpusBuilder(store, new SearchOrchestrator(search, store, null), {
      write: (corpus: unknown) => { saved = corpus; },
    } as any);
    // With no project alias lookup, the actual failure occurs in the search
    // strategy. A successful empty search used to reach CorpusStore.write.
    store.close();
    let failed = false;
    try { await builder.build('saved-knowledge', '', { query: 'knowledge' }); }
    catch { failed = true; }
    expect(failed).toBe(true);
    expect(saved).toBe(original);
  });

  it('still returns a successful empty search when the database has no matches', async () => {
    const store = new SessionStore(':memory:');
    try {
      const strategy = new SQLiteSearchStrategy(new SessionSearch(store.db));
      const result = await strategy.search({ project: 'missing' });
      expect(result.results).toEqual({ observations: [], sessions: [], prompts: [] });
      expect(result.strategy).toBe('sqlite');
    } finally { store.close(); }
  });

  it('rejects the whole search when a later requested category fails', async () => {
    const failure = new Error('database disk image is malformed');
    const strategy = new SQLiteSearchStrategy({
      searchObservations: () => [{ id: 1 }],
      searchSessions() { throw failure; },
      searchUserPrompts: () => [],
    } as any);
    let caught: unknown;
    try { await strategy.search({ query: 'knowledge', searchType: ['observations', 'sessions'] }); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
  });
});
