import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';

// The MCP `search` schema documents `type` as a category with "(default: all)",
// and SearchSelection includes 'all'. Passing it explicitly must behave like
// omitting it, not like an observation-type filter named "all".
describe("SearchManager type='all'", () => {
  function setup() {
    const store = new SessionStore(':memory:');
    const sid = store.createSDKSession('content-1', 'p', 'retry limit prompt');
    store.ensureMemorySessionIdRegistered(sid, 'memory-1');
    const epoch = Date.now();
    store.storeObservation('memory-1', 'p', {
      type: 'discovery', title: 'retry limit observation', subtitle: null, narrative: 'retry limit',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    store.storeSummary('memory-1', 'p', {
      request: 'retry limit summary', investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, epoch);
    store.saveUserPrompt('content-1', 1, 'retry limit prompt', sid);
    return new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
  }

  const counts = (r: any) => [r.observations.length, r.sessions.length, r.prompts.length];

  it('searches every category for a keyword query', async () => {
    const manager = setup();
    const omitted = await manager.search({ query: 'retry limit', format: 'json' });
    const all = await manager.search({ query: 'retry limit', type: 'all', format: 'json' });
    expect(counts(omitted)).toEqual([1, 1, 1]);
    expect(counts(all)).toEqual(counts(omitted));
  });

  it('searches every category for a filter-only query', async () => {
    const manager = setup();
    const omitted = await manager.search({ project: 'p', format: 'json' });
    const all = await manager.search({ project: 'p', type: 'all', format: 'json' });
    expect(counts(omitted)).toEqual([1, 1, 1]);
    expect(counts(all)).toEqual(counts(omitted));
  });

  it("treats a type array containing 'all' as every category", async () => {
    const manager = setup();
    expect(counts(await manager.search({ query: 'retry limit', type: ['all'], format: 'json' }))).toEqual([1, 1, 1]);
    expect(counts(await manager.search({ query: 'retry limit', type: ['all', 'sessions'], format: 'json' }))).toEqual([1, 1, 1]);
  });
});
