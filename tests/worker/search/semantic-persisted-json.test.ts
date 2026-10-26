import { expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import type { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

for (const filter of ['concepts', 'files'] as const) {
  it(`retains semantic ${filter} matches beside legacy imported metadata`, async () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const sid = store.createSDKSession('legacy-search', 'project', 'fixture');
      store.ensureMemorySessionIdRegistered(sid, 'legacy-memory');
      const epoch = Date.now();
      const row = {
        memory_session_id: 'legacy-memory', project: 'project', text: null, type: 'discovery',
        title: 'SemanticMatch', subtitle: null, narrative: 'Same meaning', facts: null,
        concepts: '["problem-solution"]', files_read: '["src/auth.ts"]', files_modified: null,
        prompt_number: 1, discovery_tokens: 0, created_at: new Date(epoch - 4000).toISOString(), created_at_epoch: epoch - 4000,
      };
      const good = store.importObservation(row).id;
      const malformed = store.importObservation({ ...row, title: 'Malformed',
        concepts: 'not-json', files_read: '[invalid', files_modified: '{"path":"src/auth.ts"}', created_at_epoch: epoch - 3000 }).id;
      const legacyConcept = store.importObservation({ ...row, title: 'Legacy concept',
        concepts: 'problem-solution', created_at_epoch: epoch - 2000 }).id;
      const object = store.importObservation({ ...row, title: 'Object metadata',
        concepts: '{"tag":"problem-solution"}', files_read: '{"path":"src/auth.ts"}', created_at_epoch: epoch - 1000 }).id;
      const ids = [object, malformed, legacyConcept, good];
      const chroma = { queryChroma: async () => ({ ids, distances: ids.map(() => 0.1),
        metadatas: ids.map(sqlite_id => ({sqlite_id, doc_type: 'observation', project: 'project', platform_source: 'claude', created_at_epoch: epoch})),
      }) } as unknown as ChromaSync;
      const sqlite = new SessionSearch(store.db);
      const manager = new SearchManager(sqlite, store, chroma, new FormattingService(), new TimelineService());
      const options = { query: 'MeaningOnly', project: 'project', type: 'observations', format: 'json',
        [filter]: filter === 'concepts' ? 'problem-solution' : 'src/auth.ts', limit: 10 };
      const result = await manager.search(options);
      expect(result.observations.map((row: {id:number}) => row.id)).toEqual([legacyConcept,good]);
      // Hydration must keep the same meaning as the keyword/filter read, including legacy concepts.
      const keyword = sqlite.searchObservations(undefined, {
        project: 'project', [filter]: filter === 'concepts' ? 'problem-solution' : 'src/auth.ts', orderBy: 'date_desc', limit: 10,
      });
      expect(keyword.map(row => row.id)).toEqual([legacyConcept,good]);
    } finally { store.close(); }
  });
}
