import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { FakeEmbedder } from './fake-embedder.js';

/**
 * The fresh-upgrade window, driven through the entry point a real search uses.
 *
 * mcp-server -> /api/search -> SearchRoutes -> SearchManager.search is the only
 * path a user's query travels; VectorSearchStrategy is reached from
 * CorpusBuilder alone. So the wiring under test here is SearchManager's, over a
 * real SessionStore/SessionSearch and a real VectorIndex — an assertion made
 * against the strategy class would pass while every real search still returned
 * a confident zero.
 */

const PROJECT = 'readiness-project';
const OTHER_PROJECT = 'someone-elses-project';
const MEMORY_SESSION_ID = 'mem-readiness';
const CONTENT_SESSION_ID = 'content-readiness';

const OBSERVATION_COUNT = 10;

function seedCorpus(store: SessionStore, project: string, sessionSuffix = ''): number[] {
  const sdkId = store.createSDKSession(CONTENT_SESSION_ID + sessionSuffix, project, 'initial prompt');
  store.updateMemorySessionId(sdkId, MEMORY_SESSION_ID + sessionSuffix);

  const ids: number[] = [];
  for (let i = 0; i < OBSERVATION_COUNT; i++) {
    const { id } = store.storeObservation(
      MEMORY_SESSION_ID + sessionSuffix,
      project,
      {
        type: 'discovery',
        title: `watermark handling ${i + 1}`,
        subtitle: null,
        facts: [`the watermark advanced past row ${i + 1}`],
        narrative: `a watermark bump skipped row ${i + 1} on the next pass`,
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      i + 1,
      0,
      Date.now() - i * 60_000,
    );
    ids.push(id);
  }
  return ids;
}

describe('search during the one-time backfill window', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let index: VectorIndex;
  let manager: SearchManager;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);
    seedCorpus(store, PROJECT);

    index = new VectorIndex(db, new FakeEmbedder());
    manager = new SearchManager(
      search,
      store,
      new VectorSync(index) as any,
      new FormattingService(),
      new TimelineService(),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('sanity: the corpus is populated and the index is not', () => {
    expect(search.searchObservations('watermark', { project: PROJECT }).length).toBe(OBSERVATION_COUNT);
    expect(index.countIndexed('observation', { project: PROJECT })).toBe(0);
  });

  it('returns keyword results instead of a confident zero while the index is empty', async () => {
    const telemetry: Record<string, unknown> = {};

    const result = await manager.search({
      query: 'watermark',
      project: PROJECT,
      format: 'json',
      limit: 20,
    }, telemetry);

    expect(result.totalResults).toBe(OBSERVATION_COUNT);
    expect(result.observations.length).toBe(OBSERVATION_COUNT);
    expect(telemetry.search_strategy).toBe('fts');
  });

  it('falls back when only ANOTHER project is indexed (scoped count, not a global one)', async () => {
    seedCorpus(store, OTHER_PROJECT, '-other');
    const otherSync = new VectorSync(index);

    // Index the other project's rows, so the vector table is non-empty globally
    // while this project's scope still holds nothing.
    const otherIds = (db.prepare('SELECT id FROM observations WHERE project = ?').all(OTHER_PROJECT) as { id: number }[])
      .map((r) => r.id);
    for (const id of otherIds) {
      await otherSync.syncObservation(id, 'unused', OTHER_PROJECT, {
        type: 'discovery', title: null, subtitle: null, facts: [],
        narrative: 'an unrelated narrative about caching', concepts: [], files_read: [], files_modified: [],
      } as any, 1, Date.now());
    }

    expect(index.countIndexed('observation')).toBeGreaterThan(0);
    expect(index.countIndexed('observation', { project: PROJECT })).toBe(0);

    const telemetry: Record<string, unknown> = {};
    const result = await manager.search({
      query: 'watermark',
      project: PROJECT,
      format: 'json',
      limit: 20,
    }, telemetry);

    expect(result.totalResults).toBe(OBSERVATION_COUNT);
    expect(telemetry.search_strategy).toBe('fts');
  });

  it('keeps a genuine zero final once this scope IS indexed', async () => {
    const sync = new VectorSync(index);
    const ids = (db.prepare('SELECT id FROM observations WHERE project = ?').all(PROJECT) as { id: number }[])
      .map((r) => r.id);
    for (const id of ids) {
      await sync.syncObservation(id, MEMORY_SESSION_ID, PROJECT, {
        type: 'discovery', title: null, subtitle: null, facts: [],
        narrative: `a watermark bump skipped row ${id}`, concepts: [], files_read: [], files_modified: [],
      } as any, 1, Date.now());
    }
    expect(index.countIndexed('observation', { project: PROJECT })).toBeGreaterThan(0);

    const telemetry: Record<string, unknown> = {};
    const result = await manager.search({
      query: 'watermark',
      project: PROJECT,
      format: 'json',
      limit: 20,
    }, telemetry);

    // The populated index answers; whatever it returns, it is not the empty
    // fallback path.
    expect(telemetry.search_strategy).toBe('chroma');
    expect(result.totalResults).toBeGreaterThan(0);
  });
});
