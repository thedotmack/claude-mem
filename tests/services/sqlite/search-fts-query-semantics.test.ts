import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

describe('search FTS query semantics', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(sessionId: string, title: string, narrative: string): void {
    const sdkId = store.createSDKSession(sessionId, 'fts-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, `${sessionId}-mem`);
    store.storeObservation(`${sessionId}-mem`, 'fts-project', {
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
    const sdkId = store.createSDKSession(`${memorySessionId}-raw`, 'fts-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.importSessionSummary({
      memory_session_id: memorySessionId,
      project: 'fts-project',
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

    seedObservation(
      'obs-1',
      'Plugin version cleanup',
      'We fixed the orphaned plugin version left behind by the installer.',
    );
    seedObservation(
      'obs-2',
      'Plugin cleanup',
      'This mention has plugin and version but not the missing term.',
    );
    seedSummary('sum-1', 'Trace orphaned plugin version mismatch during startup');
  });

  afterEach(() => {
    store.close();
  });

  it('matches multi-word observation queries with token-level AND semantics', () => {
    const results = search.searchObservations('orphaned plugin version', { project: 'fts-project' });
    expect(results.map(result => result.title)).toEqual(['Plugin version cleanup']);
  });

  it('matches multi-word observation queries without requiring an exact phrase', () => {
    const results = search.searchObservations('plugin orphaned version', { project: 'fts-project' });
    expect(results.map(result => result.title)).toEqual(['Plugin version cleanup']);
  });

  it('matches multi-word session summary queries with token-level AND semantics', () => {
    const results = search.searchSessions('orphaned plugin version', { project: 'fts-project' });
    expect(results.map(result => result.request)).toEqual(['Trace orphaned plugin version mismatch during startup']);
  });

  // unicode61 indexes nothing for a token with no letter or digit, so a lone "-" or "&"
  // quoted as its own term is an empty phrase that matches no row — ANDed in, it would
  // zero out a query the old exact-phrase search still answered.
  it('ignores standalone punctuation between terms', () => {
    expect(search.searchObservations('orphaned - plugin & version', { project: 'fts-project' }).map(r => r.title))
      .toEqual(['Plugin version cleanup']);
    expect(search.searchSessions('orphaned — plugin version', { project: 'fts-project' }).map(r => r.request))
      .toEqual(['Trace orphaned plugin version mismatch during startup']);
  });

  // No row holds every word of a pasted wall of text, so the substring
  // fallback answers it. One LIKE group per word used to exceed SQLite's
  // expression-depth limit of 1000 ("Expression tree is too large").
  it('answers a query of a thousand words without overflowing SQLite', () => {
    const wallOfText = Array.from({ length: 1000 }, (_, index) => `word${index}`).join(' ');
    expect(search.searchObservations(wallOfText, { project: 'fts-project' })).toEqual([]);
    expect(search.searchSessions(wallOfText, { project: 'fts-project' })).toEqual([]);
  });

  it('matches by substring on each distinct term, up to a cap', () => {
    const buildSubstringClause = (SessionSearch as unknown as {
      buildSubstringClause(query: string, columns: string[]): { clause: string; params: string[] };
    }).buildSubstringClause;

    // A repeated term adds nothing to an AND.
    expect(buildSubstringClause('plugin plugin version plugin', ['o.title']).params)
      .toEqual(['%plugin%', '%version%']);
    // The leading terms are kept, up to the cap.
    const capped = buildSubstringClause(Array.from({ length: 1000 }, (_, index) => `w${index}`).join(' '), ['o.title']);
    expect(capped.params).toHaveLength(SessionSearch.MAX_SUBSTRING_TERMS);
    expect(capped.params[0]).toBe('%w0%');
  });
});
