import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import type { ChromaSync } from '../../src/services/sync/ChromaSync.js';

it.each([false, true])('scopes interactive timeline candidates to the requested projects (Chroma: %s)', async useChroma => {
  const store = new SessionStore(':memory:');
  try {
    const rows = ['inside-one', 'inside-two', 'outside-three'].map(project => {
      const id = store.createSDKSession(project, project, 'fixture');
      store.ensureMemorySessionIdRegistered(id, project);
      const result = store.storeObservation(project, project, {
        type: 'discovery', title: 'needle ' + project, subtitle: null, narrative: 'fixture',
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1);
      return result.id;
    });
    const chroma = useChroma ? {
      queryChroma: async () => ({ ids: rows, distances: [0.1, 0.2, 0.3],
        metadatas: rows.map(() => ({ created_at_epoch: Date.now() })) }),
    } as unknown as ChromaSync : null;
    const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
    const result = await manager.getTimelineByQuery({ query: 'needle', mode: 'interactive', projects: 'inside-one,inside-two' });
    const text = result.content[0].text;
    expect(text).toContain('inside-one');
    expect(text).toContain('inside-two');
    expect(text).not.toContain('outside-three');
  } finally {
    store.close();
  }
});
