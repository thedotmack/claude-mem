import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import type { Embedder } from '../../src/services/vector/types.js';
import { FakeEmbedder } from './fake-embedder.js';

/**
 * Index readiness, driven through the entry point a real search uses.
 *
 * mcp-server -> /api/search -> SearchRoutes -> SearchManager.search is the only
 * path a user's query travels; VectorSearchStrategy is reached from
 * CorpusBuilder alone. So the wiring under test here is SearchManager's, over a
 * real SessionStore/SessionSearch and a real VectorIndex — an assertion made
 * against the strategy class would pass while every real search still returned
 * a confident zero.
 *
 * What these cases cover, precisely: an EMPTY scope, a scope indexed only for
 * ANOTHER project, a PARTIALLY indexed scope (the state every upgrading user is
 * in for the entire run of the one-time backfill, and the one a "> 0" readiness
 * probe reads as ready), the coverage floor from either side, a scope whose
 * vectors were all written under a model that is no longer loaded, and a
 * complete index answering a genuine zero without that zero being masked.
 *
 * What they do NOT cover: the backfill process itself (tests/vector/
 * vector-backfill.test.ts), ranking quality, and the two defects disclosed as
 * pre-existing rather than fixed here — a hydrated id list that repeats a row
 * once per document, and the 90-day default recency window swallowing a corpus
 * older than it. Assertions below are written to be indifferent to both.
 */

const PROJECT = 'readiness-project';
const OTHER_PROJECT = 'someone-elses-project';
const MEMORY_SESSION_ID = 'mem-readiness';
const CONTENT_SESSION_ID = 'content-readiness';

const OBSERVATION_COUNT = 20;

/** The floor SearchManager applies, restated so a change to it fails here. */
const COVERAGE_FLOOR = 0.9;

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

function observationIds(db: Database, project: string): number[] {
  return (db.prepare('SELECT id FROM observations WHERE project = ? ORDER BY id').all(project) as { id: number }[])
    .map((r) => r.id);
}

/**
 * Index exactly these rows, from the content actually stored on them — so the
 * vectors describe the same text FTS5 is matching and neither layer is being
 * asked about a corpus the other cannot see.
 */
async function indexRows(index: VectorIndex, db: Database, ids: number[]): Promise<void> {
  const sync = new VectorSync(index);
  for (const id of ids) {
    const row = db.prepare('SELECT id, project, narrative, facts FROM observations WHERE id = ?')
      .get(id) as { id: number; project: string; narrative: string | null; facts: string | null };
    await sync.syncObservation(row.id, MEMORY_SESSION_ID, row.project, {
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: JSON.parse(row.facts ?? '[]'),
      narrative: row.narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    } as any, 1, Date.now());
  }
}

/** FakeEmbedder's vectors under a different model identity. */
class RelabelledEmbedder implements Embedder {
  readonly dims = 384;
  private readonly inner = new FakeEmbedder();
  constructor(readonly modelId: string) {}
  embed(texts: string[]): Promise<Float32Array[]> {
    return this.inner.embed(texts);
  }
}

describe('search readiness against a partially built index', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let index: VectorIndex;
  let manager: SearchManager;

  const runSearch = async (mgr: SearchManager, args: Record<string, unknown> = {}) => {
    const telemetry: Record<string, unknown> = {};
    const result = await mgr.search({
      query: 'watermark',
      project: PROJECT,
      format: 'json',
      limit: 50,
      ...args,
    }, telemetry);
    return { result, telemetry };
  };

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
    expect(search.searchObservations('watermark', { project: PROJECT, limit: 50 }).length).toBe(OBSERVATION_COUNT);
    expect(index.countIndexed('observation', { project: PROJECT })).toBe(0);
  });

  it('returns keyword results instead of a confident zero while the index is empty', async () => {
    const { result, telemetry } = await runSearch(manager);

    expect(result.totalResults).toBe(OBSERVATION_COUNT);
    expect(result.observations.length).toBe(OBSERVATION_COUNT);
    expect(telemetry.search_strategy).toBe('fts');
  });

  it('falls back when only ANOTHER project is indexed (scoped count, not a global one)', async () => {
    seedCorpus(store, OTHER_PROJECT, '-other');
    await indexRows(index, db, observationIds(db, OTHER_PROJECT));

    expect(index.countIndexed('observation')).toBeGreaterThan(0);
    expect(index.countIndexed('observation', { project: PROJECT })).toBe(0);

    const { result, telemetry } = await runSearch(manager);

    expect(result.totalResults).toBe(OBSERVATION_COUNT);
    expect(telemetry.search_strategy).toBe('fts');
  });

  /**
   * The defect. One row of twenty indexed is not a zero to notice downstream:
   * the semantic layer answers from that one row and the caller reports
   * success. Measured against the unfixed tree this search returned
   * totalResults 2 — the one indexed row, hydrated once per document — with
   * search_strategy 'chroma', omitting the other 19 rows the user has.
   *
   * The assertion is therefore on HOW MANY OF THE USER'S ROWS the answer
   * contains, by id, not on the presence of a flag or a non-zero count. A
   * result set that repeats rows still fails it, and so does one that is merely
   * larger than before.
   */
  it('does not answer from a 1-of-20 index; returns every row the user has', async () => {
    const ids = observationIds(db, PROJECT);
    await indexRows(index, db, [ids[0]]);

    expect(index.countIndexed('observation', { project: PROJECT })).toBeGreaterThan(0);

    const { result, telemetry } = await runSearch(manager);

    const returned = new Set<number>(result.observations.map((o: { id: number }) => o.id));
    expect([...returned].sort((a, b) => a - b)).toEqual(ids);
    expect(returned.size).toBe(OBSERVATION_COUNT);
    expect(telemetry.search_strategy).toBe('fts');
  });

  it('still falls back one row below the coverage floor', async () => {
    const ids = observationIds(db, PROJECT);
    const belowFloor = Math.ceil(COVERAGE_FLOOR * OBSERVATION_COUNT) - 1;
    await indexRows(index, db, ids.slice(0, belowFloor));

    const { result, telemetry } = await runSearch(manager);

    expect(belowFloor / OBSERVATION_COUNT).toBeLessThan(COVERAGE_FLOOR);
    expect(telemetry.search_strategy).toBe('fts');
    expect(new Set(result.observations.map((o: { id: number }) => o.id)).size).toBe(OBSERVATION_COUNT);
  });

  it('does not fall back once coverage reaches the floor', async () => {
    const ids = observationIds(db, PROJECT);
    const atFloor = Math.ceil(COVERAGE_FLOOR * OBSERVATION_COUNT);
    await indexRows(index, db, ids.slice(0, atFloor));

    const { result, telemetry } = await runSearch(manager);

    expect(atFloor / OBSERVATION_COUNT).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
    expect(telemetry.search_strategy).toBe('chroma');
    expect(result.totalResults).toBeGreaterThan(0);
  });

  it('keeps a genuine zero final once this scope IS indexed', async () => {
    await indexRows(index, db, observationIds(db, PROJECT));
    expect(index.countIndexed('observation', { project: PROJECT })).toBeGreaterThan(0);

    const { result, telemetry } = await runSearch(manager);

    // The populated index answers; whatever it returns, it is not the empty
    // fallback path.
    expect(telemetry.search_strategy).toBe('chroma');
    expect(result.totalResults).toBeGreaterThan(0);
  });

  /**
   * A complete index is allowed to say "nothing". The date window drops every
   * candidate the index returned, and that zero must reach the caller as the
   * index's own answer — not be replaced by keyword hits, which is what a
   * readiness rule that fired on an empty result set would do.
   */
  it('reports a real empty from a complete index instead of masking it', async () => {
    await indexRows(index, db, observationIds(db, PROJECT));

    const { result, telemetry } = await runSearch(manager, {
      dateRange: { start: '2001-01-01', end: '2001-12-31' },
    });

    expect(result.totalResults).toBe(0);
    expect(telemetry.search_strategy).toBe('chroma');
    expect(telemetry.fallback_reason).toBe('none');
  });

  /**
   * Model change. Every row is indexed, but under a model the embedder is no
   * longer on, so query() — which filters on model_id — can read none of them.
   *
   * Verified by hand when the scoped count landed; nothing pinned it. This is
   * that pin, driven through SearchManager.search rather than through
   * VectorIndex.countIndexed, because a count asserted directly would hold
   * while a real search still returned a confident empty. It is a regression
   * guard, not a reproduction: it also passes against the unfixed tree.
   */
  it('falls back when every vector was written under a model that is no longer loaded', async () => {
    await indexRows(index, db, observationIds(db, PROJECT));
    expect(index.countIndexed('observation', { project: PROJECT })).toBeGreaterThan(0);

    const remodelled = new VectorIndex(db, new RelabelledEmbedder('test/fake-token-hash-v2/384'));
    expect(remodelled.countIndexed('observation', { project: PROJECT })).toBe(0);

    const afterModelChange = new SearchManager(
      search,
      store,
      new VectorSync(remodelled) as any,
      new FormattingService(),
      new TimelineService(),
    );

    const { result, telemetry } = await runSearch(afterModelChange);

    expect(telemetry.search_strategy).toBe('fts');
    expect(new Set(result.observations.map((o: { id: number }) => o.id)).size).toBe(OBSERVATION_COUNT);
  });
});
