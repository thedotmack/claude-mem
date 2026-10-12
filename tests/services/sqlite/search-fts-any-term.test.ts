import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// buildFTSMatchQuery joins every query token with AND (#4130), which keeps keyword queries precise. A
// natural-language question almost never has every one of its words in one row, so that form matches nothing.
// When it does, the search widens to any term, ranked by bm25, before the substring fallback.
describe('FTS5 any-term fallback for queries no row fully matches', () => {
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
    seedObservation('retry', 'Payment retry limit raised', 'The charge retry limit went from three to five after the outage');
    seedObservation('retry-only', 'Retry backoff', 'Exponential backoff between attempts');
    seedObservation('auth', 'Login token lifetime', 'Access tokens now expire after eight days');
    seedSummary('sum-retry', 'Raise the payment retry limit after the outage');
    seedSummary('sum-auth', 'Shorten the login token lifetime');
  });

  afterEach(() => {
    store.close();
  });

  it('answers a natural-language question whose words never all appear in one observation', () => {
    const results = search.searchObservations('when did we change the payment retry limit', { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Payment retry limit raised');
  });

  it('keeps a query the AND form answers precise: no widening to rows holding only some terms', () => {
    const results = search.searchObservations('retry limit', { project: 'proj' });
    expect(results.map(r => r.title)).toEqual(['Payment retry limit raised']);
  });

  it('does not widen a single-token query', () => {
    expect(search.searchObservations('nonexistentterm', { project: 'proj' })).toEqual([]);
  });

  it('keeps a two-term keyword query strict even when one of its terms matches (#4130)', () => {
    expect(search.searchObservations('outage dashboards', { project: 'proj' })).toEqual([]);
  });

  it('answers a natural-language question over session summaries the same way', () => {
    const results = search.searchSessions('why did we raise the payment retry limit', { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].request).toBe('Raise the payment retry limit after the outage');
  });

  it('pages the widened results and keeps a page past the end empty', () => {
    const question = 'when did the payment retry limit and backoff change';
    const all = search.searchObservations(question, { project: 'proj' });
    expect(all.length).toBe(2);
    const second = search.searchObservations(question, { project: 'proj', limit: 1, offset: 1 });
    expect(second.map(r => r.id)).toEqual([all[1].id]);
    expect(search.searchObservations(question, { project: 'proj', limit: 1, offset: 5 })).toEqual([]);
  });

  it('respects the project filter when widening', () => {
    expect(search.searchObservations('when did we change the payment retry limit', { project: 'other' })).toEqual([]);
  });
});
