import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import type { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

let store: SessionStore;
afterEach(() => store?.close());

function fixture() {
  store = new SessionStore(':memory:');
  const rows: Array<{ id: number; project: string; created_at_epoch: number }> = [];
  const add = (project: string, title: string, mergedInto?: string) => {
    const sid = store.createSDKSession(title, project, 'prompt');
    const memory = store.ensureMemorySessionIdRegistered(sid, 'memory-' + title);
    const epoch = Date.now();
    const { id } = store.storeObservation(memory, project, {
      type: 'discovery', title, subtitle: null, narrative: 'needle', facts: [],
      concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    if (mergedInto) store.db.run('UPDATE observations SET merged_into_project = ? WHERE id = ?', [mergedInto, id]);
    rows.push({ id, project, created_at_epoch: epoch });
    return id;
  };
  // A whole repo merge must retain the worktree rows it had already adopted.
  const own = add('work', 'own');
  const repo = add('repo', 'repo', 'work');
  const worktree = add('repo/feature', 'worktree', 'repo');
  const adopted = add('private', 'adopted', 'work');
  add('private', 'unadopted');
  add('unrelated', 'unrelated');
  // Whole merges retain every generation, not only the first adopted worktree.
  const deep = add('deep', 'adopted-through-chain', 'repo/feature');
  // A partial source is not a read key. Neither its direct nor deeper adopted
  // descendants may cross that boundary into work, even in semantic results.
  add('private/feature', 'unadopted-child', 'private');
  add('private/deep', 'unadopted-grandchild', 'private/feature');
  const search = new SessionSearch(store.db);
  const chroma = { queryChroma: async () => ({
    ids: rows.map(row => row.id), distances: rows.map(() => 0.1),
    metadatas: rows.map(row => ({ ...row, sqlite_id: row.id, doc_type: 'observation' })),
  }) } as unknown as ChromaSync;
  return { search, chroma, expected: [own, repo, worktree, adopted, deep].sort((a, b) => a - b) };
}

describe('corpus project scope matches interactive memory retrieval', () => {
  for (const mode of ['filter-only', 'keyword', 'semantic', 'semantic-empty'] as const) {
    it(`keeps whole merge chains without crossing partial adoption (${mode})`, async () => {
      const { search, chroma, expected } = fixture();
      const query = mode === 'filter-only' ? undefined : 'needle';
      const vector = mode.startsWith('semantic') ? chroma : null;
      if (mode === 'semantic-empty') chroma.queryChroma = async () => ({ ids: [], distances: [], metadatas: [] });
      const manager = new SearchManager(search, store, vector, new FormattingService(), new TimelineService());
      const interactive = await manager.search({ project: 'work', query, type: 'observations', format: 'json', limit: 50 });
      expect(interactive.observations.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b)).toEqual(expected);
      const builder = new CorpusBuilder(store, new SearchOrchestrator(search, store, vector), {} as any);
      const corpus = await builder.build('merged-project', '', { project: 'work', query, limit: 50 }, { writeFile: false });
      expect(corpus.observations.map(row => row.id).sort((a, b) => a - b)).toEqual(expected);
      expect(corpus.filter.project).toBe('work');
    });
  }
});
