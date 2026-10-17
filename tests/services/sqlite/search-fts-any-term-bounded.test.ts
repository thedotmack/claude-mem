import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// The any-term fallback (#4696) ORs every token of a query no row fully matches. Without a bound,
// a pasted prompt of hundreds of words makes FTS5 score the whole index on common words — 1-7 s
// per prompt on a 133k-observation database, minutes for long ones (#4804). The widened query is
// built from deduplicated tokens, ranked rarest-first by document frequency, capped by prompt
// size, and held to a posting budget, so its cost is bounded while the rarest (highest-IDF, and
// therefore highest-ranked) terms always survive.
describe('bounded any-term queries (#4804)', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(sessionId: string, title: string, narrative: string): void {
    const sdkId = store.createSDKSession(sessionId, 'proj', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, `${sessionId}-mem`);
    store.storeObservation(`${sessionId}-mem`, 'proj', {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  function seedSummary(memorySessionId: string, request: string): void {
    const sdkId = store.createSDKSession(`${memorySessionId}-raw`, 'proj', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.importSessionSummary({
      memory_session_id: memorySessionId,
      project: 'proj',
      request,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    });
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    seedObservation('filler-a', 'alpha progress note one', 'routine alpha update with no findings');
    seedObservation('filler-b', 'bravo progress note two', 'routine bravo update with no findings');
    seedObservation('filler-c', 'alpha bravo note three', 'routine combined update with no findings');
    seedObservation('rare', 'Zephyrquake oscillator drift', 'The zephyrquake compensation loop was retuned');
    seedSummary('sum-rare', 'Retune the compensation loop after the oscillator drift');
  });

  afterEach(() => {
    store.close();
  });

  it('creates a document-frequency table over each FTS index', () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observations_fts_vocab', 'session_summaries_fts_vocab')")
      .all() as { name: string }[];
    expect(tables.map(t => t.name).sort()).toEqual(['observations_fts_vocab', 'session_summaries_fts_vocab']);
  });

  it('selects the rarest terms within the prompt-size cap', () => {
    const tokens = Array.from({ length: 300 }, (_, i) => `zztoken${String(i).padStart(3, '0')}`);
    const docs = new Map(tokens.map((t, i) => [t, i + 1]));
    const selected = SessionSearch.selectAnyTermTokens(2500, tokens, docs);
    expect(selected.length).toBe(SessionSearch.anyTermTokenCap(2500));
    // Rarest first: the 40 lowest document frequencies survive, the ubiquitous tail is dropped.
    expect(selected[0]).toBe('zztoken000');
    expect(selected).not.toContain('zztoken299');
  });

  it('deduplicates repeated tokens case-insensitively before selecting', () => {
    const selected = SessionSearch.selectAnyTermTokens(50, ['Retry', 'retry', 'RETRY', 'limit'], null);
    expect(selected).toEqual(['Retry', 'limit']);
  });

  it('drops a term whose postings would blow the budget, keeping rarer ones', () => {
    const docs = new Map([['ubiquitous', 500_000], ['scarce', 5], ['unique', 1]]);
    const selected = SessionSearch.selectAnyTermTokens(80, ['ubiquitous', 'scarce', 'unique'], docs);
    expect(selected).toEqual(['unique', 'scarce']);
  });

  it('always keeps at least one term even when every token is ubiquitous', () => {
    const docs = new Map([['one', 500_000], ['two', 400_000]]);
    // 'two' is the rarer of the two, so the budget admits it first and then stops.
    const selected = SessionSearch.selectAnyTermTokens(80, ['one', 'two'], docs);
    expect(selected).toEqual(['two']);
  });

  it('finds the one distinctive row inside a query of common words', () => {
    const results = search.searchObservations('when did the routine progress update mention zephyrquake', { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Zephyrquake oscillator drift');
  });

  it('widens over session summaries with the same bound', () => {
    const results = search.searchSessions('why did the compensation loop need retuning today', { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].request).toBe('Retune the compensation loop after the oscillator drift');
  });
});
