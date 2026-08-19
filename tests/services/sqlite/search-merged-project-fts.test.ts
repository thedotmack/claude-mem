import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// #3641 — the FTS/filter path (buildFilterClause) must honor merged_into_project
// like every other read path, so observations adopted into the parent project
// stay reachable from search. Before the fix it filtered on `project = ?` only,
// so adopted worktree observations were invisible to /api/search.
describe('search honors merged_into_project (FTS + filter-only)', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(
    memorySessionId: string,
    project: string,
    mergedInto: string | null,
    title: string,
    narrative: string,
  ): void {
    const sdkId = store.createSDKSession(memorySessionId, project, 'prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
    if (mergedInto !== null) {
      store.db
        .prepare('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?')
        .run(mergedInto, memorySessionId);
    }
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    // Adopted worktree observation: filed under the compound name, merged into
    // the parent.
    seedObservation('wt-mem', 'main-repo/feature-x', 'main-repo', 'Worktree finding', 'shared adoption keyword');
    // Native parent observation.
    seedObservation('parent-mem', 'main-repo', null, 'Parent finding', 'shared adoption keyword');
  });

  afterEach(() => {
    store.close();
  });

  it('FTS search by parent project returns adopted worktree observations', () => {
    const results = search.searchObservations('adoption', { project: 'main-repo' });
    const sessions = results.map(r => r.memory_session_id).sort();
    expect(sessions).toEqual(['parent-mem', 'wt-mem']);
  });

  it('filter-only search by parent project returns adopted worktree observations', () => {
    const results = search.searchObservations(undefined, { project: 'main-repo' });
    const sessions = results.map(r => r.memory_session_id).sort();
    expect(sessions).toEqual(['parent-mem', 'wt-mem']);
  });
});
