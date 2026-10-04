import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

describe('file search preserves explicit date ordering with Chroma', () => {
  let store: SessionStore;
  afterEach(() => store?.close());
  function seed(epoch: number): number {
    const memoryId = `memory-${epoch}`;
    const sdkId = store.createSDKSession(`content-${epoch}`, 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memoryId);
    return store.storeObservation(memoryId, 'project', {
      type: 'discovery', title: memoryId, subtitle: null, narrative: memoryId,
      facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
    }, 1, 0, epoch).id;
  }
  function setup(ranking: 'newest' | 'oldest') {
    store = new SessionStore(':memory:');
    const ids = [seed(100), seed(200), seed(300)];
    const chroma = { queryChroma: async () => ({
      ids: ranking === 'newest' ? [...ids].reverse() : ids,
      distances: [0.1, 0.2, 0.3], metadatas: [],
    }) };
    return { ids, search: new SearchOrchestrator(new SessionSearch(store.db), store, chroma as any) };
  }
  for (const isFolder of [false, true]) {
    for (const orderBy of ['date_asc', 'date_desc'] as const) {
      it(`${isFolder ? 'folder' : 'file'} ${orderBy} overrides the opposite semantic ranking`, async () => {
        const { ids, search } = setup(orderBy === 'date_asc' ? 'newest' : 'oldest');
        const result = await search.findByFile(isFolder ? 'src' : 'src/file.ts', {
          project: 'project', isFolder, limit: 3, orderBy,
        });
        expect(result.observations.map(row => row.id)).toEqual(orderBy === 'date_asc' ? ids : [...ids].reverse());
      });
    }
  }
  it('keeps the date-ordered metadata page after applying offset', async () => {
    const { ids, search } = setup('newest');
    const result = await search.findByFile('src/file.ts', {
      project: 'project', limit: 2, offset: 1, orderBy: 'date_asc',
    });
    expect(result.observations.map(row => row.id)).toEqual(ids.slice(1));
  });
  for (const orderBy of [undefined, 'relevance'] as const) {
    it(`retains semantic ranking for ${orderBy ?? 'default'} ordering`, async () => {
      const { ids, search } = setup('oldest');
      const result = await search.findByFile('src/file.ts', { project: 'project', limit: 3, orderBy });
      expect(result.observations.map(row => row.id)).toEqual(ids);
      expect(result.usedChroma).toBe(true);
    });
  }
});
