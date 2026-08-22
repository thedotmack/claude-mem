import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { SearchOrchestrator } from '../../src/services/worker/search/SearchOrchestrator.js';
import { ChromaUnavailableError } from '../../src/services/worker/search/errors.js';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { decodeEmbedding, VECTOR_TABLES } from '../../src/services/vector/schema.js';
import type { VectorDoc, VectorDocKind, VectorHit } from '../../src/services/vector/types.js';
import { FakeEmbedder } from './fake-embedder.js';

/**
 * What a search costs in memory, and what it returns — measured on the path a
 * user's query actually travels.
 *
 * The costly half of that path is VectorIndex.query, reached through
 * VectorSync.queryChroma from SearchManager (the mcp-server /api/search route)
 * and from VectorSearchStrategy (corpus building). Above query() every stage is
 * already bounded by the candidate pool: queryChroma returns three arrays of at
 * most `limit` entries. Below it, the candidate scan used to materialise a row
 * object, a 1,536-byte embedding and a hit entry for EVERY vector in scope, and
 * hold them all until the scan ended — on the operation a user performs most.
 *
 * These tests are driven through SearchManager.search rather than against
 * VectorIndex directly, so the number they report is what a real search costs.
 */

const MB = 1024 * 1024;

/** Vectors in the small scope. */
const SMALL_VECTORS = 10_000;
/** Vectors in the large scope. Four times the small one — the whole point. */
const BIG_VECTORS = 40_000;

const SMALL_PROJECT = 'small-scope';
const BIG_PROJECT = 'big-scope';

const QUERY = 'shared state and cache coherence';

interface Corpus {
  db: Database;
  store: SessionStore;
  index: VectorIndex;
  manager: SearchManager;
}

function narrativeFor(project: string, i: number): string {
  return `${project} narrative ${i} about shared state and cache coherence`;
}

/**
 * Rows go in by prepared INSERT rather than through storeObservation: the
 * schema is the real one (SessionStore creates it, FTS triggers and all), and
 * at these sizes the parse-and-render work of the write API is seconds of test
 * time that measures nothing here. Vectors are written by VectorIndex.upsert —
 * the real writer — so the rows being scanned are the rows production writes.
 */
function seedProject(
  db: Database,
  store: SessionStore,
  project: string,
  count: number,
): VectorDoc[] {
  const sdkId = store.createSDKSession(`cs-${project}`, project, 'initial prompt');
  store.updateMemorySessionId(sdkId, `ms-${project}`);

  const insert = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, created_at, created_at_epoch, narrative)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const docs: VectorDoc[] = [];
  const now = Date.now();
  db.run('BEGIN');
  for (let i = 0; i < count; i++) {
    const narrative = narrativeFor(project, i);
    const { lastInsertRowid } = insert.run(
      `ms-${project}`, project, `observation ${i}`, 'discovery',
      new Date(now).toISOString(), now, narrative,
    );
    const id = Number(lastInsertRowid);
    docs.push({
      docId: `obs_${id}_narrative`,
      sqliteId: id,
      fieldType: 'narrative',
      factIndex: null,
      text: narrative,
    });
  }
  db.run('COMMIT');
  return docs;
}

async function buildCorpus(): Promise<Corpus> {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  const store = new SessionStore(db);
  const search = new SessionSearch(db);
  const index = new VectorIndex(db, new FakeEmbedder());

  // Both scopes live in ONE store, so the only thing that differs between the
  // two searches below is how many vectors are in scope.
  await index.upsert('observation', seedProject(db, store, SMALL_PROJECT, SMALL_VECTORS));
  await index.upsert('observation', seedProject(db, store, BIG_PROJECT, BIG_VECTORS));

  const manager = new SearchManager(
    search,
    store,
    new VectorSync(index) as any,
    new FormattingService(),
    new TimelineService(),
  );
  return { db, store, index, manager };
}

/**
 * Heap held at the moment a search hands its answer back.
 *
 * Read immediately after search() resolves and before anything else allocates,
 * with no collection in between: what the scan retained is still counted. The
 * candidate rows cannot be collected DURING the scan either — the old code kept
 * the whole array live until it finished — so this is the peak, not a leftover.
 */
async function heapHeldBySearch(manager: SearchManager, project: string): Promise<number> {
  // Three passes with a turn of the event loop between them. One synchronous
  // Bun.gc(true) leaves the previous search's garbage behind often enough to
  // read a NEGATIVE delta when the collector catches up mid-measurement.
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await Bun.sleep(0);
  }
  const before = process.memoryUsage().heapUsed;
  const result = await manager.search({ query: QUERY, project, format: 'json', limit: 20 }, {});
  const after = process.memoryUsage().heapUsed;
  // Reading the result here also keeps it alive across the measurement.
  expect(result.observations.length).toBeGreaterThan(0);
  return after - before;
}

describe('memory held by a search', () => {
  let corpus: Corpus;

  // Seeding 50,000 rows and their vectors takes longer than the default hook
  // timeout allows; the sizes are what make the difference readable.
  beforeAll(async () => {
    corpus = await buildCorpus();
  }, 120_000);

  afterAll(() => {
    corpus.db.close();
  });

  it('sanity: one store, two scopes, four times as many vectors in the larger', () => {
    expect(corpus.index.countIndexed('observation', { project: SMALL_PROJECT })).toBe(SMALL_VECTORS);
    expect(corpus.index.countIndexed('observation', { project: BIG_PROJECT })).toBe(BIG_VECTORS);
  });

  it('does not scale with the number of vectors in scope', async () => {
    // Warm the paths first; the first search of a process also pays for lazily
    // compiled code and prepared statements, which is not what is being read.
    await heapHeldBySearch(corpus.manager, SMALL_PROJECT);
    await heapHeldBySearch(corpus.manager, BIG_PROJECT);

    const small = await heapHeldBySearch(corpus.manager, SMALL_PROJECT);
    const big = await heapHeldBySearch(corpus.manager, BIG_PROJECT);

    const extraVectors = BIG_VECTORS - SMALL_VECTORS;
    const perVector = (big - small) / extraVectors;
    const report =
      `small scope (${SMALL_VECTORS} vectors): ${(small / MB).toFixed(1)}MB, `
      + `big scope (${BIG_VECTORS} vectors): ${(big / MB).toFixed(1)}MB, `
      + `${perVector.toFixed(0)} bytes per additional vector in scope`;

    // Unbounded, one row object plus one 1,536-byte embedding plus one hit
    // entry per vector costs roughly 2.5KB each; bounded by K, an extra 30,000
    // vectors in scope cost nothing that survives the scan.
    expect(big - small, report).toBeLessThan(8 * MB);
    expect(big, report).toBeLessThan(16 * MB);
  }, 120_000);
});

/**
 * Ranking parity.
 *
 * The bounded scan must return the same hits in the same order as the
 * materialise-everything-then-sort it replaces, ties included. `referenceTopK`
 * below IS that previous algorithm — every candidate row decoded, scored,
 * pushed, then one stable sort and a slice — so this compares the new result
 * against the old one on the same corpus rather than against a re-derivation of
 * what the new code does.
 *
 * This test passes on both sides of the change, which is the point of it: it
 * would fail the moment the top-K or its order moved.
 */
function referenceTopK(
  db: Database,
  probe: Float32Array,
  kinds: VectorDocKind[],
  project: string,
  limit: number,
): Array<Pick<VectorHit, 'kind' | 'docId' | 'sqliteId' | 'score'>> {
  const hits: Array<Pick<VectorHit, 'kind' | 'docId' | 'sqliteId' | 'score'>> = [];
  for (const kind of kinds) {
    const spec = VECTOR_TABLES[kind];
    const rows = db.prepare(`
      SELECT v.doc_id, v.sqlite_id, v.embedding
      FROM ${spec.table} v
      ${spec.joinSql}
      WHERE (${spec.projectExpr} = ? OR ${spec.mergedExpr ?? 'NULL'} = ?)
        AND v.model_id = ?
    `).all(project, project, new FakeEmbedder().modelId) as Array<{
      doc_id: string; sqlite_id: number; embedding: Uint8Array;
    }>;
    for (const row of rows) {
      const vec = decodeEmbedding(row.embedding);
      let score = 0;
      for (let i = 0; i < probe.length; i++) score += probe[i] * vec[i];
      hits.push({ kind, docId: row.doc_id, sqliteId: row.sqlite_id, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

describe('ranking parity with the unbounded scan', () => {
  const PROJECT = 'parity';
  let db: Database;
  let index: VectorIndex;
  let probe: Float32Array;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    const store = new SessionStore(db);
    index = new VectorIndex(db, new FakeEmbedder());

    const sdkId = store.createSDKSession('cs-parity', PROJECT, 'initial prompt');
    store.updateMemorySessionId(sdkId, 'ms-parity');
    const insert = db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, text, type, created_at, created_at_epoch, narrative)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const docs: VectorDoc[] = [];
    const now = Date.now();
    for (let i = 0; i < 400; i++) {
      // Every fourth narrative is a duplicate of an earlier one, so scores tie
      // and tie ordering is exercised rather than assumed away.
      const narrative = i % 4 === 0
        ? 'shared state contention on the coordinator'
        : `narrative ${i} about ${i % 7} cache coherence and shared state`;
      const { lastInsertRowid } = insert.run(
        'ms-parity', PROJECT, `observation ${i}`, 'discovery',
        new Date(now).toISOString(), now, narrative,
      );
      docs.push({
        docId: `obs_${Number(lastInsertRowid)}_narrative`,
        sqliteId: Number(lastInsertRowid),
        fieldType: 'narrative',
        factIndex: null,
        text: narrative,
      });
    }
    await index.upsert('observation', docs);
    [probe] = await new FakeEmbedder().embed([QUERY]);
  });

  afterAll(() => {
    db.close();
  });

  for (const limit of [1, 5, 100, 1000]) {
    it(`returns the same top ${limit} in the same order`, async () => {
      const expected = referenceTopK(db, probe, ['observation'], PROJECT, limit);
      const actual = await index.query({
        text: QUERY, kinds: ['observation'], project: PROJECT, limit,
      });

      expect(actual.length).toBe(expected.length);
      expect(actual.map((h) => h.docId)).toEqual(expected.map((h) => h.docId));
      expect(actual.map((h) => h.score)).toEqual(expected.map((h) => h.score));
    });
  }

  it('has ties in the corpus, so the order above is a real claim', async () => {
    const top = await index.query({
      text: QUERY, kinds: ['observation'], project: PROJECT, limit: 200,
    });
    const tied = top.filter((h, i) => i > 0 && h.score === top[i - 1].score);
    expect(tied.length).toBeGreaterThan(0);
  });

  it('returns nothing for a limit that asks for nothing', async () => {
    expect(await index.query({ text: QUERY, kinds: ['observation'], project: PROJECT, limit: 0 })).toEqual([]);
  });

  /**
   * The whole domain of `limit`, measured as the number of hits that come back
   * from query() on the corpus above.
   *
   * query() is a public method of an exported class and `limit` is a plain
   * number, so every one of these values is something a caller can hand it.
   * The repository's own caller does not: VectorSync.queryChroma forwards
   * SEARCH_CONSTANTS.SEMANTIC_CANDIDATE_POOL, an integer 100, and it is the
   * only call site in src/. So one case here is a defect test and the rest are
   * guards, and they are labelled as such:
   *
   *  - DEFECT, 0 < limit < 1: the guard tested `q.limit > 0` while the cap used
   *    Math.floor(q.limit), so 0.5 passed the guard and built a TopHits of
   *    capacity 0. Its wouldKeep then read hits[-1].score on the first
   *    candidate row and threw a TypeError out of query(). Both cases in that
   *    range throw on the parent commit; every other case here passes on it
   *    unchanged.
   *  - GUARD, everything else: floor(limit) hits for a non-negative limit,
   *    which is the count Array.slice(0, limit) gave in the unbounded scan
   *    (Infinity: no cap, the whole scope; NaN: none), and nothing at all for a
   *    negative one, where slice(0, -1) instead counted from the end and
   *    returned all but the last hit.
   */
  const CORPUS_SIZE = 400;

  const LIMIT_CASES: Array<{ label: string; limit: number; hits: number }> = [
    { label: 'a negative integer', limit: -1, hits: 0 },
    { label: 'a negative fraction', limit: -0.5, hits: 0 },
    { label: 'zero', limit: 0, hits: 0 },
    { label: 'a fraction below one', limit: 0.5, hits: 0 },
    { label: 'a fraction just below one', limit: 0.999999, hits: 0 },
    { label: 'one', limit: 1, hits: 1 },
    { label: 'a fraction just above one', limit: 1.5, hits: 1 },
    { label: 'a larger fraction', limit: 7.25, hits: 7 },
    { label: 'more than the scope holds', limit: 1e9, hits: CORPUS_SIZE },
    { label: 'Infinity', limit: Number.POSITIVE_INFINITY, hits: CORPUS_SIZE },
    { label: 'NaN', limit: Number.NaN, hits: 0 },
  ];

  it('sanity: the parity scope holds every one of its vectors', () => {
    expect(index.countIndexed('observation', { project: PROJECT })).toBe(CORPUS_SIZE);
  });

  for (const { label, limit, hits } of LIMIT_CASES) {
    it(`returns ${hits} hits for ${label} (limit ${limit})`, async () => {
      const actual = await index.query({
        text: QUERY, kinds: ['observation'], project: PROJECT, limit,
      });
      expect(actual.length).toBe(hits);
    });
  }

  // Counting hits says the call survived; comparing them says it ranked the
  // same as before. Negative limits are excluded because they are the one
  // place the answer deliberately differs from slice's from-the-end reading.
  for (const { label, limit } of LIMIT_CASES.filter((c) => !(c.limit < 0))) {
    it(`ranks ${label} (limit ${limit}) exactly as the unbounded scan did`, async () => {
      const expected = referenceTopK(db, probe, ['observation'], PROJECT, limit);
      const actual = await index.query({
        text: QUERY, kinds: ['observation'], project: PROJECT, limit,
      });
      expect(actual.map((h) => h.docId)).toEqual(expected.map((h) => h.docId));
      expect(actual.map((h) => h.score)).toEqual(expected.map((h) => h.score));
    });
  }
});

/**
 * The readiness probe, on the path VectorSearchStrategy is actually reached
 * from: CorpusBuilder.build -> SearchOrchestrator.search -> the strategy.
 *
 * The strategy asked "does this index hold anything" without a scope, so a
 * project with rows and no vectors of its own read as populated the moment
 * ANOTHER project had been indexed — and the empty semantic result was handed
 * back as an answer instead of raising the not-ready signal the orchestrator
 * turns into a keyword fallback.
 */
describe('index-readiness probe reached through SearchOrchestrator', () => {
  const UNINDEXED = 'alpha';
  const INDEXED = 'beta';

  let db: Database;
  let orchestrator: SearchOrchestrator;
  let index: VectorIndex;
  let sync: VectorSync;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    const store = new SessionStore(db);
    const search = new SessionSearch(db);
    index = new VectorIndex(db, new FakeEmbedder());
    sync = new VectorSync(index);

    seedProject(db, store, UNINDEXED, 150);
    const betaDocs = seedProject(db, store, INDEXED, 2);
    await index.upsert('observation', betaDocs);

    orchestrator = new SearchOrchestrator(search, store, sync as any);
  });

  afterAll(() => {
    db.close();
  });

  it("sanity: the store holds another project's vectors and none of this one's", () => {
    expect(index.countIndexed('observation')).toBe(2);
    expect(index.countIndexed('observation', { project: UNINDEXED })).toBe(0);
  });

  it('refuses to report an unindexed project as a genuine zero', async () => {
    await expect(
      orchestrator.search({ query: QUERY, project: UNINDEXED, type: 'observations' }),
    ).rejects.toBeInstanceOf(ChromaUnavailableError);
  });

  it('still answers a project that has no content at all with an empty result', async () => {
    // Not-ready is a claim about the backfill, not about an unknown project.
    // Raising it here would turn "this project has nothing" into a thrown
    // ChromaUnavailableError the moment any other project held vectors.
    const result = await orchestrator.search({
      query: QUERY, project: 'never-used-project', type: 'observations',
    });
    expect(result.results.observations).toEqual([]);
  });

  it('answers normally once this project IS indexed', async () => {
    const docs = (db.prepare('SELECT id, narrative FROM observations WHERE project = ? LIMIT 20')
      .all(UNINDEXED) as Array<{ id: number; narrative: string }>)
      .map((row) => ({
        docId: `obs_${row.id}_narrative`,
        sqliteId: row.id,
        fieldType: 'narrative',
        factIndex: null,
        text: row.narrative,
      }));
    await index.upsert('observation', docs);
    expect(index.countIndexed('observation', { project: UNINDEXED })).toBe(20);

    const result = await orchestrator.search({ query: QUERY, project: UNINDEXED, type: 'observations' });
    expect(result.results.observations.length).toBeGreaterThan(0);
  });
});
