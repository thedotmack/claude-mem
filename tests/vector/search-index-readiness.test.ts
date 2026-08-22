import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager, READINESS_TTL_MS } from '../../src/services/worker/SearchManager.js';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import type { Embedder } from '../../src/services/vector/types.js';
import { FakeEmbedder } from './fake-embedder.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

/**
 * Index readiness, driven through the entry point the gated search uses.
 *
 * THE PATH, read end to end rather than assumed: the MCP `search` tool
 * (src/servers/mcp-server.ts) calls callWorker('/api/search'), which is
 * SearchRoutes.handleUnifiedSearch, which calls SearchManager.search; the
 * readiness gate lives in performChromaSemanticSearch, and search() is its only
 * caller. That is the path every case below drives, over a real
 * SessionStore/SessionSearch and a real VectorIndex.
 *
 * THREE THINGS THAT PATH IS NOT, all of which an earlier version of this header
 * asserted or implied, and all of which are wrong:
 *
 *  1. It is not "the only path a user's query travels". /api/search/observations
 *     reaches SearchManager.searchObservations and /api/timeline/by-query
 *     reaches getTimelineByQuery, and both run their own Chroma path
 *     (hybridSemanticHydrate) rather than this one. Those two are now gated on
 *     the same probe and memo, and the second describe block below measures
 *     them through those two public methods. /api/search/by-file is still
 *     ungated — SearchRoutes.handleSearchByFile goes to
 *     SearchOrchestrator.findByFile and HybridSearchStrategy, neither of which
 *     is touched here — and nothing below measures it.
 *  2. The MCP `search` tool does not always reach the worker at all: on a
 *     server-beta install, a plain text query for observations is routed to
 *     /v1/search and never touches SearchManager.
 *  3. VectorSearchStrategy is not on this path. It is constructed only by
 *     SearchOrchestrator and used only in SearchOrchestrator.search, whose only
 *     caller is CorpusBuilder. (SearchRoutes does reach the orchestrator, but
 *     for findByFile, which uses HybridSearchStrategy.) An assertion made
 *     against the strategy class would therefore hold while every gated search
 *     still returned a confident zero.
 *
 * What these cases cover: an EMPTY scope, a scope indexed only for ANOTHER
 * project, a PARTIALLY indexed scope (the state every upgrading user is in for
 * the whole run of the one-time backfill), a FULLY BACKFILLED scope that still
 * contains rows no backfill can ever give a vector, the agreement between the
 * readiness rule's idea of "indexable" and VectorBackfill's, the memo that
 * keeps the probe off the hot path, a scope whose vectors were all written
 * under a model that is no longer loaded, and a complete index answering a
 * genuine zero without that zero being masked.
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

/**
 * An observation carrying a title and concepts and nothing else — no narrative,
 * no text, no facts. VectorBackfill renders it to zero documents and passes
 * over it exactly once; nothing in the system will ever give it a vector.
 */
function seedDocLessObservation(store: SessionStore, project: string, n: number): number {
  return store.storeObservation(
    MEMORY_SESSION_ID,
    project,
    {
      type: 'discovery',
      title: `watermark, titled only ${n}`,
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: ['watermark'],
      files_read: [],
      files_modified: [],
    },
    500 + n,
    0,
    Date.now() - n * 60_000,
  ).id;
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

/**
 * Run the REAL backfill until it reports nothing left, the way the worker's
 * re-arm timer does. Using it rather than hand-written upserts is the point of
 * the doc-less cases: it is the component that decides which rows get a vector,
 * so it is the only honest source of the state readiness has to read.
 */
async function backfillToCompletion(db: Database, index: VectorIndex): Promise<number> {
  const backfill = new VectorBackfill(db, index);
  let passes = 0;
  while (!backfill.isComplete(index.modelId)) {
    await backfill.runBatch();
    passes++;
    if (passes > 100) throw new Error('backfill did not converge');
  }
  return passes;
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

  const newManager = (idx: VectorIndex) => new SearchManager(
    search,
    store,
    new VectorSync(idx) as any,
    new FormattingService(),
    new TimelineService(),
  );

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);
    seedCorpus(store, PROJECT);

    index = new VectorIndex(db, new FakeEmbedder());
    manager = newManager(index);
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
   * One row of twenty indexed is not a zero to notice downstream: the semantic
   * layer answers from that one row and the caller reports success. Measured
   * against the tree before any readiness gate existed, this search returned
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

  /**
   * 19 of 20 is not "ready", and this is the case that decides it.
   *
   * The predecessor accepted any coverage at or above 0.9, so this exact state
   * answered from the index, reported search_strategy 'chroma' and
   * fallback_reason 'none', and left one of the user's rows out of a result the
   * caller was told was semantic. Measured against that tree: 'chroma', with
   * the unindexed row's id absent from the observations array. That is a
   * smaller copy of the 1-of-20 defect above, not slack, and there is no size
   * of omission at which telling a user their row does not exist becomes fine.
   *
   * The bar is now every INDEXABLE row (see the doc-less cases below for the
   * other half of that), so this falls back and the user gets all twenty rows
   * from keyword search.
   */
  it('falls back one row short of full coverage rather than omitting that row', async () => {
    const ids = observationIds(db, PROJECT);
    const indexed = ids.slice(0, OBSERVATION_COUNT - 1);
    await indexRows(index, db, indexed);

    expect(indexed.length / OBSERVATION_COUNT).toBe(0.95);

    const { result, telemetry } = await runSearch(manager);

    expect(telemetry.search_strategy).toBe('fts');
    const returned = new Set<number>(result.observations.map((o: { id: number }) => o.id));
    expect(returned.size).toBe(OBSERVATION_COUNT);
    expect(returned.has(ids[OBSERVATION_COUNT - 1])).toBe(true);
  });

  /**
   * DEFECT: a short history pinned on keyword search forever.
   *
   * Some rows can never be indexed — an observation with only a title and
   * concepts renders zero documents, and VectorBackfill is built around that
   * (its cursor exists so such rows are passed over once, and isComplete()
   * reports done with them still vectorless). Counting them as missing puts a
   * permanent floor on coverage that no amount of indexing can lift.
   *
   * Measured against the tree before this fix, with the REAL backfill driven to
   * completion: isComplete() true, 17 of 20 parent rows carrying vectors,
   * coverage 0.85 against the 0.9 floor, search_strategy 'fts' — and there was
   * nothing left to run that could ever change it. The smaller the history the
   * likelier this is; a 10-row project needs only two such rows.
   *
   * The assertion is on the SEARCH, not on a computed coverage number: coverage
   * is the intermediate quantity, and asserting it would pass over a rule that
   * computed 1.0 and still fell back.
   */
  it('treats a fully backfilled corpus as ready even when some rows can never be indexed', async () => {
    const docLess = [1, 2, 3].map((n) => seedDocLessObservation(store, PROJECT, n));
    expect(docLess.length).toBe(3);

    await backfillToCompletion(db, index);

    // The state the assertion below is about: the backfill is finished, and
    // three of the twenty-three rows still have no vector because none is
    // renderable from them.
    const total = observationIds(db, PROJECT).length;
    const withVectors = (db.prepare(
      'SELECT COUNT(DISTINCT sqlite_id) AS n FROM vec_observation_docs',
    ).get() as { n: number }).n;
    expect(total).toBe(OBSERVATION_COUNT + 3);
    expect(withVectors).toBe(OBSERVATION_COUNT);

    const { telemetry } = await runSearch(manager);

    expect(telemetry.search_strategy).toBe('chroma');
    expect(telemetry.fallback_reason).toBe('none');
  });

  /**
   * The same defect where it bites hardest: a history so short that a single
   * doc-less row is more than a tenth of it.
   */
  it('is ready on a five-row history where one row can never be indexed', async () => {
    db.run('DELETE FROM observations');
    for (let i = 0; i < 4; i++) {
      store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
        type: 'discovery', title: `watermark ${i}`, subtitle: null,
        facts: [], narrative: `a watermark bump skipped row ${i}`,
        concepts: [], files_read: [], files_modified: [],
      }, i + 1, 0, Date.now() - i * 60_000);
    }
    seedDocLessObservation(store, PROJECT, 9);

    await backfillToCompletion(db, index);

    const { telemetry } = await runSearch(manager);
    expect(telemetry.search_strategy).toBe('chroma');
  });

  /**
   * GUARD, not a reproduction — it passes against the unfixed tree too, where
   * every one of these rows is indexed and coverage is 1.0 either way.
   *
   * What it guards is drift. The readiness rule names the content columns a row
   * can be indexed from (SearchManager.INDEXABLE_CONTENT); VectorBackfill owns
   * the real list, and the two are separate declarations. A column named by
   * readiness that the backfill does NOT render leaves its row owed a vector
   * forever and the scope permanently on keyword search — the doc-less defect
   * above, arriving by drift instead of by design.
   *
   * One row whose ONLY content is each named column, then the real backfill to
   * completion, then the search must be index-backed. Drift the other way (the
   * backfill rendering a column readiness does not name) is harmless: that row
   * gets its vector anyway and is merely not required to have one.
   */
  it('agrees with VectorBackfill about every column a row can be indexed from', async () => {
    db.run('DELETE FROM observations');

    // observations.narrative
    store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
      type: 'discovery', title: 'n', subtitle: null, facts: [],
      narrative: 'a watermark bump skipped a row', concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now());

    // observations.text — the legacy base column, which no writer on the
    // current schema populates, so it is moved into place directly.
    const textOnly = store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
      type: 'discovery', title: 't', subtitle: null, facts: [],
      narrative: 'watermark text column row', concepts: [], files_read: [], files_modified: [],
    }, 2, 0, Date.now()).id;
    db.run('UPDATE observations SET text = narrative, narrative = NULL WHERE id = ?', [textOnly]);

    // observations.facts
    store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
      type: 'discovery', title: 'f', subtitle: null,
      facts: ['the watermark advanced past a row'], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }, 3, 0, Date.now());

    // session_summaries: one row per text column, the other five left empty.
    const summaryColumns = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;
    for (const column of summaryColumns) {
      const summary = {
        request: '', investigated: '', learned: '', completed: '', next_steps: '', notes: '',
      } as Record<(typeof summaryColumns)[number], string>;
      summary[column] = `watermark ${column} content`;
      store.storeSummary(MEMORY_SESSION_ID, PROJECT, summary as any, 1, 0, Date.now());
    }

    // user_prompts.prompt_text
    store.saveUserPrompt(CONTENT_SESSION_ID, 1, 'what happened to the watermark');

    await backfillToCompletion(db, index);

    const { telemetry } = await runSearch(manager);
    expect(telemetry.search_strategy).toBe('chroma');
  });

  /**
   * The probe behind readiness used to run a full parent scan with a correlated
   * EXISTS per row before EVERY semantic query, for the life of the worker
   * (36ms over 20,000 observations, 200ms over 100,000). It is memoised now,
   * and a memo that outlives the state it summarises would reintroduce the
   * original defect silently — so both directions are pinned, on ONE manager
   * instance, which is the thing that holds the memo.
   *
   * This first one is a GUARD: it passes against the unfixed tree, which has no
   * memo to go stale. It fails only against a memo that latches "not ready".
   */
  it('stops using the memo once the backfill fills the gap it was taken over', async () => {
    const ids = observationIds(db, PROJECT);
    await indexRows(index, db, ids.slice(0, 5));

    expect((await runSearch(manager)).telemetry.search_strategy).toBe('fts');

    await backfillToCompletion(db, index);

    expect((await runSearch(manager)).telemetry.search_strategy).toBe('chroma');
  });

  /**
   * The other direction — a memo that latches "ready". This one DOES fail
   * against the unfixed tree, for the floor's own reason rather than the memo's:
   * 20 of 21 rows indexed is 0.952, which cleared 0.9, so the new row was left
   * out of a result reported as search_strategy 'chroma'. Measured: 'chroma'
   * where this expects 'fts'.
   */
  it('stops using the memo once a row arrives that the index has never seen', async () => {
    await backfillToCompletion(db, index);
    expect((await runSearch(manager)).telemetry.search_strategy).toBe('chroma');

    store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
      type: 'discovery', title: 'late arrival', subtitle: null, facts: [],
      narrative: 'a watermark bump skipped the newest row', concepts: [],
      files_read: [], files_modified: [],
    }, 900, 0, Date.now());

    expect((await runSearch(manager)).telemetry.search_strategy).toBe('fts');
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

    const { result, telemetry } = await runSearch(newManager(remodelled));

    expect(telemetry.search_strategy).toBe('fts');
    expect(new Set(result.observations.map((o: { id: number }) => o.id)).size).toBe(OBSERVATION_COUNT);
  });
});

/**
 * Observation ids as a caller reads them off the two sibling paths' rendered
 * output: `| #12 |` in the FormattingService table searchObservations returns,
 * `- ID: 12` in the list getTimelineByQuery returns. Read from the text those
 * methods actually hand back, so the count asserted is the count a user sees.
 */
function idsInObservationTable(text: string): number[] {
  return [...text.matchAll(/\|\s*#(\d+)\s*\|/g)].map((m) => Number(m[1]));
}

function idsInTimelineList(text: string): number[] {
  return [...text.matchAll(/- ID:\s*(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The gate on the OTHER two search paths, and the memo's blind spots.
 *
 * These do not go through SearchManager.search at all. /api/search/observations
 * reaches searchObservations and /api/timeline/by-query reaches
 * getTimelineByQuery; both call hybridSemanticHydrate, and both fall back to
 * keyword search only when the semantic answer is EMPTY — which a part-built
 * index does not produce. It answers from the slice it has, and the caller
 * renders that as a success.
 *
 * Every case here drives one of those two public methods and counts the
 * DISTINCT observation ids in the text it returns, because that is the quantity
 * that goes wrong: rows the user has, missing from an answer reported as found.
 * No case asserts a flag, a strategy label, or a coverage number.
 */
describe('readiness on the sibling search paths', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let index: VectorIndex;
  let manager: SearchManager;

  const newManager = (idx: VectorIndex, sync?: VectorSync) => new SearchManager(
    search,
    store,
    (sync ?? new VectorSync(idx)) as any,
    new FormattingService(),
    new TimelineService(),
  );

  beforeEach(() => {
    // searchObservations renders through FormattingService, which asks
    // ModeManager for a type icon; without a mode loaded that throws before any
    // assertion is reached. The worker loads one at boot.
    ModeManager.getInstance().loadMode('code');
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);
    seedCorpus(store, PROJECT);
    index = new VectorIndex(db, new FakeEmbedder());
    manager = newManager(index);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * DEFECT. Measured against the tree before this gate, with 1 of 20 rows
   * indexed: searchObservations returned the header "Found 1 observation(s)
   * matching "watermark"" and a single row, id 1. The other 19 rows the user
   * has were absent from an answer that reported success — the same defect
   * already fixed on SearchManager.search, on an endpoint that had not been
   * fixed with it.
   */
  it('searchObservations returns every row the user has, not the slice already indexed', async () => {
    const ids = observationIds(db, PROJECT);
    await indexRows(index, db, [ids[0]]);

    const response = await manager.searchObservations({ query: 'watermark', project: PROJECT, limit: 50 });
    const returned = new Set(idsInObservationTable(response.content[0].text as string));

    expect([...returned].sort((a, b) => a - b)).toEqual(ids);
    expect(returned.size).toBe(OBSERVATION_COUNT);
  });

  /**
   * DEFECT, the same one on the other endpoint. Measured against the tree
   * before this gate, 1 of 20 indexed: getTimelineByQuery listed one match,
   * id 1, and called it "Found 1 observation(s)".
   */
  it('getTimelineByQuery returns every row the user has, not the slice already indexed', async () => {
    const ids = observationIds(db, PROJECT);
    await indexRows(index, db, [ids[0]]);

    const response = await manager.getTimelineByQuery({
      query: 'watermark', project: PROJECT, mode: 'interactive', limit: 50,
    });
    const returned = new Set(idsInTimelineList(response.content[0].text as string));

    expect([...returned].sort((a, b) => a - b)).toEqual(ids);
    expect(returned.size).toBe(OBSERVATION_COUNT);
  });

  /**
   * The other half of the gate: it has to STOP firing. A gate that always fell
   * back would pass both cases above while turning semantic search off, so this
   * counts the semantic queries the path issues — zero while the scope is
   * incomplete (no embedding work spent on an answer that would be discarded),
   * one once the backfill has finished.
   *
   * The first count is a reproduction, not a guard: against the tree before the
   * gate it measured 1, the query whose partial answer the two cases above are
   * about. The second is what keeps this from being satisfied by disabling
   * semantic search.
   */
  it('spends no semantic query while incomplete, and resumes querying once indexed', async () => {
    const sync = new VectorSync(index) as any;
    const realQuery = sync.queryChroma.bind(sync);
    let semanticQueries = 0;
    sync.queryChroma = (...args: unknown[]) => { semanticQueries++; return realQuery(...args); };
    const gated = newManager(index, sync);

    await indexRows(index, db, [observationIds(db, PROJECT)[0]]);
    await gated.searchObservations({ query: 'watermark', project: PROJECT, limit: 50 });
    expect(semanticQueries).toBe(0);

    await backfillToCompletion(db, index);
    const response = await gated.searchObservations({ query: 'watermark', project: PROJECT, limit: 50 });
    expect(semanticQueries).toBe(1);
    expect(idsInObservationTable(response.content[0].text as string).length).toBeGreaterThan(0);
  });
});

/**
 * The memo's blind spots, driven through SearchManager.search.
 *
 * The memo answers "is this scope indexed" without rescanning while its
 * counters stand still. Two edits move no counter: a vector deleted with no
 * other write, and an in-place UPDATE that gives content to a row that had
 * none. Both leave a scope genuinely short of coverage while it keeps reporting
 * a complete semantic answer, and the assertions below are on the rows in that
 * answer, not on the counters.
 */
describe('readiness memo staleness', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let index: VectorIndex;
  let manager: SearchManager;

  const runSearch = async (args: Record<string, unknown> = {}) => {
    const telemetry: Record<string, unknown> = {};
    const result = await manager.search({
      query: 'watermark', project: PROJECT, format: 'json', limit: 50, ...args,
    }, telemetry);
    return { result, telemetry, ids: new Set<number>(result.observations.map((o: { id: number }) => o.id)) };
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);
    seedCorpus(store, PROJECT);
    index = new VectorIndex(db, new FakeEmbedder());
    manager = new SearchManager(
      search, store, new VectorSync(index) as any, new FormattingService(), new TimelineService(),
    );
  });

  afterEach(() => {
    db.close();
  });

  /**
   * DEFECT. VectorBackfill.discardPartialRow deletes the committed slices of a
   * row whose remaining slices threw, and that delete is frequently the only
   * write in the window. MAX(parent.id) cannot fall, and MAX(vector.rowid) only
   * falls if the deleted row happened to hold the top rowid — so a row in the
   * MIDDLE of the table takes its vectors away without moving either counter.
   *
   * Measured against the tree before the count was added to the memo's
   * counters, on a fully backfilled 20-row project: the next search reported
   * search_strategy 'chroma' with fallback_reason 'none' and returned 19 rows,
   * the emptied row's id absent.
   */
  it('notices a row whose vectors were deleted with no other write', async () => {
    await backfillToCompletion(db, index);
    expect((await runSearch()).ids.size).toBe(OBSERVATION_COUNT);

    const ids = observationIds(db, PROJECT);
    const emptied = ids[Math.floor(ids.length / 2)];
    index.deleteByParent('observation', emptied);

    // The state the assertion is about: one row of twenty carries no vector,
    // and nothing else about the store has changed.
    const withVectors = (db.prepare(
      'SELECT COUNT(DISTINCT sqlite_id) AS n FROM vec_observation_docs',
    ).get() as { n: number }).n;
    expect(withVectors).toBe(OBSERVATION_COUNT - 1);

    const after = await runSearch();
    expect(after.ids.has(emptied)).toBe(true);
    expect(after.ids.size).toBe(OBSERVATION_COUNT);
  });

  /**
   * GUARD, not a reproduction — it passes against the unfixed tree too, which
   * has the same TTL.
   *
   * What it pins is the bound this effort is claiming rather than closing. An
   * in-place UPDATE that gives content to a doc-less row mints no id and writes
   * no vector, so no counter moves and the memo keeps answering "complete" with
   * that row missing from every semantic result. Measured, immediately after
   * such an UPDATE, on BOTH trees: search_strategy 'chroma', fallback_reason
   * 'none', the amended row's id absent. Only READINESS_TTL_MS ends that, and
   * the comment on it states the window in those terms.
   *
   * Time is moved by ageing the memo entries, because there is no clock seam to
   * inject one through and a test that slept a minute would not be run.
   */
  it('does not let a stale "complete" outlive the readiness TTL', async () => {
    const amended = seedDocLessObservation(store, PROJECT, 1);
    await backfillToCompletion(db, index);
    expect((await runSearch()).ids.size).toBe(OBSERVATION_COUNT);

    db.run('UPDATE observations SET narrative = ? WHERE id = ?', [
      'a watermark bump skipped the amended row', amended,
    ]);

    const memo = (manager as unknown as {
      scopeReadiness: Map<string, { takenAt: number }>;
    }).scopeReadiness;
    expect(memo.size).toBeGreaterThan(0);
    for (const entry of memo.values()) entry.takenAt -= READINESS_TTL_MS + 1_000;

    const after = await runSearch();
    expect(after.ids.has(amended)).toBe(true);
    expect(after.ids.size).toBe(OBSERVATION_COUNT + 1);
  });
});
