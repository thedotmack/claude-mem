import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// Regression (#019f64f9): an empty search — no query text and no
// project/platformSource/dateRange filters — must return an empty result set,
// not throw. Previously the filter-only path in SearchManager forwarded this
// benign request straight into these methods, which threw an AppError that
// bubbled up as an uncaught worker exception into error tracking.
describe('search with no query and no filters', () => {
  let store: SessionStore;
  let search: SessionSearch;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    const sdkId = store.createSDKSession('sess', 'empty-input-project', 'prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(sdkId, 'mem');
    store.storeObservation('mem', 'empty-input-project', {
      type: 'discovery',
      title: 'Some finding',
      subtitle: null,
      facts: [],
      narrative: 'a narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
    store.saveUserPrompt('sess', 1, 'a prompt', sdkId);
  });

  afterEach(() => {
    store.close();
  });

  it('searchObservations returns [] instead of throwing', () => {
    expect(search.searchObservations(undefined, {})).toEqual([]);
  });

  it('searchSessions returns [] instead of throwing', () => {
    expect(search.searchSessions(undefined, {})).toEqual([]);
  });

  it('searchUserPrompts returns [] instead of throwing', () => {
    expect(search.searchUserPrompts(undefined, {})).toEqual([]);
  });

  it('still applies filters on the no-query path (project filter)', () => {
    expect(search.searchObservations(undefined, { project: 'empty-input-project' }).length).toBe(1);
    expect(search.searchUserPrompts(undefined, { project: 'empty-input-project' }).length).toBe(1);
  });
});
