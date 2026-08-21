import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { VectorSearchStrategy } from '../../src/services/worker/search/strategies/VectorSearchStrategy.js';
import { FakeEmbedder } from './fake-embedder.js';
import type { Embedder } from '../../src/services/vector/types.js';

/**
 * The observations fixture carries `text` because the real one does: it is in
 * the BASE table (SessionStore, `text TEXT NOT NULL`), while narrative/facts
 * only arrive at schema v8 via a bare ALTER TABLE with no backfill. Every
 * observation captured before v8 therefore has text and nothing else, and a
 * fixture without the column cannot see that those rows exist.
 */
function createCorpusDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
          memory_session_id TEXT, project TEXT, platform_source TEXT)`);
  db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, text TEXT, narrative TEXT, facts TEXT,
          created_at_epoch INTEGER)`);
  db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, request TEXT, learned TEXT, created_at_epoch INTEGER)`);
  db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT,
          prompt_text TEXT, created_at_epoch INTEGER)`);
  db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'ms-1', 'alpha', 'claude');
  return db;
}

const insertObs = (db: Database) => db.prepare(`INSERT INTO observations
  (id, memory_session_id, project, merged_into_project, text, narrative, facts, created_at_epoch)
  VALUES (?,?,?,?,?,?,?,?)`);

/** Drives passes to completion, bounded, and reports how many it took. */
async function drain(backfill: VectorBackfill, modelId: string, cap: number): Promise<number> {
  let passes = 0;
  while (!backfill.isComplete(modelId) && passes < cap) {
    await backfill.runBatch();
    passes++;
  }
  return passes;
}

describe('VectorBackfill', () => {
  let db: Database;
  let index: VectorIndex;
  let backfill: VectorBackfill;
  let startedIncomplete: boolean;

  beforeAll(async () => {
    db = createCorpusDb();

    // A pre-existing corpus, as an upgrading install would have.
    const obs = insertObs(db);
    for (let i = 1; i <= 5; i++) {
      obs.run(i, 'ms-1', 'alpha', null, null, `narrative number ${i} about shared state`,
        JSON.stringify([`fact a${i}`, `fact b${i}`]), Date.now());
    }
    // Malformed facts JSON must not stall a migration that touches every row.
    obs.run(6, 'ms-1', 'alpha', null, null, 'narrative six', '{not valid json', Date.now());
    // Pre-v8 shape: text populated, narrative and facts never written.
    obs.run(7, 'ms-1', 'alpha', null, 'legacy flat observation about a stale cache read',
      null, null, Date.now());

    db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?,?,?)')
      .run(1, 'ms-1', 'alpha', null, 'the request', 'the lesson', Date.now());
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)')
      .run(1, 'cs-1', 'how do agents avoid clobbering', Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    backfill = new VectorBackfill(db, index);

    startedIncomplete = !backfill.isComplete(index.modelId);
    await drain(backfill, index.modelId, 20);
  });

  it('reports incomplete before running', () => {
    expect(startedIncomplete).toBe(true);
  });

  it('reaches completion', () => {
    expect(backfill.isComplete(index.modelId)).toBe(true);
  });

  it('embeds every observation document', () => {
    // 5 rows x (1 narrative + 2 facts) + row 6 narrative only (bad JSON)
    // + row 7 text only (pre-v8) = 17
    expect(index.countIndexed('observation')).toBe(17);
  });

  it('indexes a pre-v8 observation from its text column', () => {
    const ids = (db.prepare('SELECT doc_id FROM vec_observation_docs WHERE sqlite_id = 7')
      .all() as { doc_id: string }[]).map((r) => r.doc_id);
    expect(ids).toEqual(['obs_7_text']);
  });

  it('leaves a pre-v8 observation searchable', async () => {
    const hits = await index.query({
      text: 'legacy flat observation about a stale cache read',
      kinds: ['observation'], project: 'alpha', limit: 3,
    });
    expect(hits[0].sqliteId).toBe(7);
    expect(hits[0].fieldType).toBe('text');
  });

  it('embeds summaries and prompts', () => {
    expect(index.countIndexed('summary')).toBe(2);
    expect(index.countIndexed('prompt')).toBe(1);
  });

  it('is a no-op once complete', async () => {
    const progress = await backfill.runBatch();
    expect(progress.every((p) => p.processed === 0 && p.remaining === 0)).toBe(true);
  });

  it('leaves the backfilled corpus searchable', async () => {
    const hits = await index.query({
      text: 'narrative number 3 about shared state',
      kinds: ['observation'], project: 'alpha', limit: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});

/**
 * Regression: a parent row that yields ZERO documents must not keep the pass
 * alive forever.
 *
 * Progress is only recordable at document granularity (a vector row per
 * document), so a set-difference predicate — "rows with no vector" — can never
 * be satisfied by a doc-less row. With ORDER BY id LIMIT n, the lowest-id
 * doc-less rows are re-selected in EVERY batch and the window never advances,
 * so isComplete() stays false and DatabaseManager re-arms its 1s timer forever.
 *
 * Doc-less rows are ordinary, not pathological: a brand-new install can write
 * an observation with only title+concepts (parser.ts skips only when all four
 * of title/narrative/facts/concepts are empty), a session_summaries row can
 * have all six text fields NULL, and a user_prompts row can have ''.
 *
 * There are deliberately MORE doc-less observations than BATCH_SIZE, so a
 * set-difference implementation cannot reach the good rows behind them at all.
 */
describe('VectorBackfill with doc-less rows', () => {
  const DOCLESS_OBSERVATIONS = 210; // > BATCH_SIZE (200)
  let db: Database;
  let index: VectorIndex;
  let backfill: VectorBackfill;
  let passes: number;

  beforeAll(async () => {
    db = createCorpusDb();
    const obs = insertObs(db);
    for (let i = 1; i <= DOCLESS_OBSERVATIONS; i++) {
      // title+concepts only: nothing this index can embed.
      obs.run(i, 'ms-1', 'alpha', null, null, null, null, Date.now());
    }
    for (let i = DOCLESS_OBSERVATIONS + 1; i <= DOCLESS_OBSERVATIONS + 3; i++) {
      obs.run(i, 'ms-1', 'alpha', null, null, `narrative ${i} about a wedged backfill`, null, Date.now());
    }

    const sum = db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?,?,?)');
    sum.run(1, 'ms-1', 'alpha', null, null, null, Date.now()); // every text field NULL
    sum.run(2, 'ms-1', 'alpha', null, 'a real request', null, Date.now());

    const pr = db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)');
    pr.run(1, 'cs-1', '', Date.now()); // empty prompt_text
    pr.run(2, 'cs-1', 'how do agents avoid clobbering', Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    backfill = new VectorBackfill(db, index);
    passes = await drain(backfill, index.modelId, 25);
  });

  it('terminates instead of spinning forever', () => {
    expect(backfill.isComplete(index.modelId)).toBe(true);
    expect(passes).toBeLessThan(25);
  });

  it('still embeds the documents that exist behind the doc-less rows', () => {
    expect(index.countIndexed('observation')).toBe(3);
    expect(index.countIndexed('summary')).toBe(1);
    expect(index.countIndexed('prompt')).toBe(1);
  });

  it('reports remaining === 0 once the pass is finished', async () => {
    const progress = await backfill.runBatch();
    expect(progress.every((p) => p.processed === 0 && p.remaining === 0)).toBe(true);
  });

  /**
   * Mirrors DatabaseManager.scheduleBackfill's recurrence exactly (check
   * isComplete, run a batch, re-arm only if there is more to do) against a
   * fresh backfill over the same doc-less corpus. The assertion is that the
   * chain stops re-arming, which is what the 1 Hz spin was.
   */
  it('lets a DatabaseManager-shaped re-arm loop stop', async () => {
    const fresh = new VectorBackfill(db, index);
    let rearms = 0;
    let armed = true;
    while (armed) {
      if (rearms++ > 25) break;
      if (fresh.isComplete(index.modelId)) { armed = false; break; }
      const progress = await fresh.runBatch();
      armed = !progress.every((p) => p.remaining === 0);
    }
    expect(armed).toBe(false);
    expect(rearms).toBeLessThanOrEqual(25);
  });
});

/**
 * Regression: peak memory during a backfill pass must be bounded by DOCUMENTS,
 * not by parent rows.
 *
 * BATCH_SIZE caps rows, but one observation renders to narrative + text + one
 * document per fact, so a row-capped batch can hand the embedder an unbounded
 * array. A transformer embeds a batch in one padded forward pass whose
 * activations scale with the batch, which is how 200 rows became gigabytes of
 * resident memory on the low-memory machines this index exists to serve.
 */
class RecordingEmbedder extends FakeEmbedder {
  readonly callSizes: number[] = [];
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.callSizes.push(texts.length);
    return super.embed(texts);
  }
}

describe('VectorBackfill document batching', () => {
  const ROWS = 60; // deliberately BELOW BATCH_SIZE, so rows cannot be the bound
  const FACTS_PER_ROW = 50;
  const DOCS_PER_ROW = FACTS_PER_ROW + 1; // facts + narrative
  const TOTAL_DOCS = ROWS * DOCS_PER_ROW;
  /** Documents per embed call the backfill is allowed to reach. */
  const DOC_CAP = 1024;

  let db: Database;
  let index: VectorIndex;
  let backfill: VectorBackfill;
  let embedder: RecordingEmbedder;

  beforeAll(async () => {
    db = createCorpusDb();
    const obs = insertObs(db);
    for (let i = 1; i <= ROWS; i++) {
      const facts = Array.from({ length: FACTS_PER_ROW }, (_, f) => `fact ${f} of row ${i} about contention`);
      obs.run(i, 'ms-1', 'alpha', null, null, `narrative ${i} about a wide row`,
        JSON.stringify(facts), Date.now());
    }
    embedder = new RecordingEmbedder();
    index = new VectorIndex(db, embedder);
    backfill = new VectorBackfill(db, index);
    await drain(backfill, index.modelId, 100);
  });

  it('never hands the embedder more documents than the cap', () => {
    const largest = Math.max(...embedder.callSizes);
    expect(largest).toBeLessThanOrEqual(DOC_CAP);
  });

  it('still embeds every document behind the cap', () => {
    expect(index.countIndexed('observation')).toBe(TOTAL_DOCS);
    expect(backfill.isComplete(index.modelId)).toBe(true);
  });
});

/**
 * Regression: LocalEmbedder must bound the batch it hands the model.
 *
 * The caller's array size is not the model's batch size to choose. One padded
 * forward pass over N documents allocates activations proportional to N, so an
 * uncapped array is an uncapped allocation. The subclass replaces the model
 * call, so this exercises the batching without loading the ONNX runtime.
 */
class ProbeEmbedder extends LocalEmbedder {
  readonly callSizes: number[] = [];
  protected async encode(texts: string[]): Promise<Float32Array[]> {
    this.callSizes.push(texts.length);
    return texts.map(() => new Float32Array(this.dims));
  }
}

describe('LocalEmbedder batching', () => {
  const CHUNK_CAP = 32;

  it('splits a large array into capped model calls', async () => {
    const embedder = new ProbeEmbedder();
    const vectors = await embedder.embed(Array.from({ length: 1000 }, (_, i) => `document ${i}`));

    expect(vectors).toHaveLength(1000);
    expect(Math.max(...embedder.callSizes)).toBeLessThanOrEqual(CHUNK_CAP);
    expect(embedder.callSizes.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('preserves input order across chunk boundaries', async () => {
    class OrderedProbe extends LocalEmbedder {
      protected async encode(texts: string[]): Promise<Float32Array[]> {
        return texts.map((text) => {
          const vec = new Float32Array(this.dims);
          vec[0] = Number(text);
          return vec;
        });
      }
    }
    const vectors = await new OrderedProbe().embed(
      Array.from({ length: 100 }, (_, i) => String(i)),
    );
    expect(vectors.map((v) => v[0])).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('returns nothing for an empty array without calling the model', async () => {
    const embedder = new ProbeEmbedder();
    expect(await embedder.embed([])).toEqual([]);
    expect(embedder.callSizes).toEqual([]);
  });
});

/**
 * Regression: while the one-time backfill is still running, the index holds
 * nothing to match against. A zero-hit lookup against an unpopulated index is
 * not the same fact as "the corpus contains nothing relevant", and returning
 * it as a successful empty search hides an upgrade in progress behind an
 * answer that looks authoritative.
 */
describe('VectorSearchStrategy while the backfill is unfinished', () => {
  let db: Database;
  let index: VectorIndex;
  let backfill: VectorBackfill;
  let strategy: VectorSearchStrategy;

  const hydrated = {
    id: 1,
    project: 'alpha',
    narrative: 'narrative number 1 about shared state',
    created_at_epoch: Date.now(),
  };

  beforeAll(() => {
    db = createCorpusDb();
    const obs = insertObs(db);
    for (let i = 1; i <= 3; i++) {
      obs.run(i, 'ms-1', 'alpha', null, null, `narrative number ${i} about shared state`,
        JSON.stringify([`fact a${i}`]), Date.now());
    }
    index = new VectorIndex(db, new FakeEmbedder());
    backfill = new VectorBackfill(db, index);

    const sessionStore = {
      getAllProjects: () => ['alpha'],
      getObservationsByIds: () => [hydrated],
      getSessionSummariesByIds: () => [],
      getUserPromptsByIds: () => [],
    };
    strategy = new VectorSearchStrategy(new VectorSync(index), sessionStore as any);
  });

  it('refuses to report an unpopulated index as zero matches', async () => {
    expect(index.countIndexed('observation')).toBe(0);
    await expect(
      strategy.search({ query: 'shared state', searchType: 'observations', project: 'alpha' }),
    ).rejects.toThrow(/not ready|still building|backfill/i);
  });

  it('answers normally once the backfill has populated the index', async () => {
    await drain(backfill, index.modelId, 20);
    expect(index.countIndexed('observation')).toBeGreaterThan(0);

    const result = await strategy.search({
      query: 'narrative number 1 about shared state',
      searchType: 'observations',
      project: 'alpha',
    });
    expect(result.results.observations).toEqual([hydrated]);
    expect(result.usedChroma).toBe(true);
  });
});

/**
 * A platform-scoped zero has its own keyword fallback one level up
 * (SearchOrchestrator), and that fallback returns real rows. Signalling
 * "not ready" there would replace working results with an error, so the
 * unpopulated-index signal stays out of that path.
 */
describe('VectorSearchStrategy with a platform-scoped query', () => {
  it('still returns an empty result so the caller can fall back', async () => {
    const db = createCorpusDb();
    insertObs(db).run(1, 'ms-1', 'alpha', null, null, 'narrative about shared state', null, Date.now());
    const index = new VectorIndex(db, new FakeEmbedder());
    const sessionStore = {
      getAllProjects: () => ['alpha'],
      getObservationsByIds: () => [],
      getSessionSummariesByIds: () => [],
      getUserPromptsByIds: () => [],
    };
    const strategy = new VectorSearchStrategy(new VectorSync(index), sessionStore as any);

    const result = await strategy.search({
      query: 'shared state',
      searchType: 'observations',
      project: 'alpha',
      platformSource: 'cursor',
    });
    expect(result.results.observations).toEqual([]);
  });
});

/**
 * Records what actually reached the embedder, and samples RSS at the moment a
 * pass has finished accumulating — which is where peak allocation sits.
 *
 * Deliberately NOT FakeEmbedder: tokenising a 400KB string per document would
 * allocate more than the code under test does, and the double would be what
 * the measurement measured.
 */
class SamplingEmbedder implements Embedder {
  readonly modelId = 'test/sampling/384';
  readonly dims = 384;
  peakRss = 0;
  readonly callDocs: number[] = [];
  readonly callChars: number[] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.callDocs.push(texts.length);
    let chars = 0;
    for (const text of texts) chars += text.length;
    this.callChars.push(chars);
    this.sample();
    return texts.map(() => new Float32Array(this.dims));
  }

  sample(): void {
    this.peakRss = Math.max(this.peakRss, process.memoryUsage.rss());
  }
}

/** Rows whose facts are `factChars` wide, so bytes vary independently of count. */
function seedWideRows(db: Database, rows: number, factsPerRow: number, factChars: number): void {
  const obs = insertObs(db);
  for (let i = 1; i <= rows; i++) {
    const facts = Array.from({ length: factsPerRow }, (_, f) => `f${f}r${i} `.padEnd(factChars, 'x'));
    obs.run(i, 'ms-1', 'alpha', null, null, `narrative ${i}`, JSON.stringify(facts), Date.now());
  }
}

/** Documents the backfill contract allows into one embedder call. */
const DOC_CAP = 1024;
/** Characters the backfill contract allows into one embedder call. */
const CHAR_CAP = 4 * 1024 * 1024;

/**
 * Regression: peak resident memory during the one-time indexing must be bounded
 * by BYTES, not by document count.
 *
 * A document cap bounds nothing on its own. This corpus and a 400-BYTE-fact
 * corpus of the same shape render to the identical 1,020 documents and produce
 * the identical 1,020-document embedder call, yet this one allocated 910MB
 * against the other's 12MB — a batch strictly UNDER the 1,024-document cap
 * resident-setting most of a gigabyte on exactly the low-memory machines this
 * index exists to serve. Two causes, both measured: the row SELECT materialised
 * every row's facts blob before any cap could be consulted, and the cap counted
 * documents while the cost was in characters.
 *
 * Measured as a delta from a pre-drain baseline. RSS never shrinks, so anything
 * this process already allocated only makes the assertion more forgiving —
 * never falsely red.
 */
describe('VectorBackfill peak memory on a byte-heavy corpus', () => {
  const ROWS = 170;
  const FACTS_PER_ROW = 5;
  const CHARS_PER_FACT = 400_000;
  const TOTAL_DOCS = ROWS * (FACTS_PER_ROW + 1); // facts + narrative
  /** Measured 910MB before, 49MB after. Anything near the old figure is a fail. */
  const RSS_CEILING_BYTES = 250 * 1024 * 1024;

  let index: VectorIndex;
  let backfill: VectorBackfill;
  let embedder: SamplingEmbedder;
  let peakDelta: number;

  beforeAll(async () => {
    const db = createCorpusDb();
    seedWideRows(db, ROWS, FACTS_PER_ROW, CHARS_PER_FACT);

    Bun.gc(true);
    const baseline = process.memoryUsage.rss();

    embedder = new SamplingEmbedder();
    embedder.peakRss = baseline;
    index = new VectorIndex(db, embedder);
    backfill = new VectorBackfill(db, index);

    let passes = 0;
    while (!backfill.isComplete(index.modelId) && passes < 5_000) {
      await backfill.runBatch();
      embedder.sample();
      passes++;
    }
    peakDelta = embedder.peakRss - baseline;
  });

  it('keeps peak resident memory off the gigabyte scale', () => {
    expect(peakDelta).toBeLessThan(RSS_CEILING_BYTES);
  });

  it('never hands the embedder more characters than the cap', () => {
    expect(Math.max(...embedder.callChars)).toBeLessThanOrEqual(CHAR_CAP);
  });

  it('still indexes every document behind the budget', () => {
    expect(index.countIndexed('observation')).toBe(TOTAL_DOCS);
    expect(backfill.isComplete(index.modelId)).toBe(true);
  });
});

/**
 * Regression: the document cap must apply to the FIRST row too.
 *
 * The old guard read `docs.length > 0 && docs.length + rowDocs.length > CAP`,
 * which exempted the opening row of every pass entirely — so one row wide
 * enough produced a single embedder call of 12,001 documents, twelve times the
 * cap, and no cap on a later row could undo it. A pass over 60 narrow rows
 * never triggered this, which is why a batching test built from narrow rows
 * passed while a single wide row went through whole.
 */
describe('VectorBackfill with one row wider than the cap', () => {
  const FACTS = 12_000;
  let index: VectorIndex;
  let embedder: SamplingEmbedder;

  beforeAll(async () => {
    const db = createCorpusDb();
    seedWideRows(db, 1, FACTS, 200);
    embedder = new SamplingEmbedder();
    index = new VectorIndex(db, embedder);
    const backfill = new VectorBackfill(db, index);
    await drain(backfill, index.modelId, 200);
  });

  it('never exceeds the document cap on a single wide row', () => {
    expect(Math.max(...embedder.callDocs)).toBeLessThanOrEqual(DOC_CAP);
  });

  it('still indexes every document of that row', () => {
    expect(index.countIndexed('observation')).toBe(FACTS + 1);
  });
});

/**
 * Regression: LocalEmbedder must bound a forward pass by BYTES as well as by
 * document count.
 *
 * A document count is not a size. Thirty-two documents is a few kilobytes of
 * ordinary narrative and megabytes of 400KB facts, and the tokenizer walks
 * every character of both before the model truncates anything — so a fixed
 * 32-document chunk left the largest chunk the caller could produce entirely
 * unbounded in bytes.
 */
describe('LocalEmbedder chunking by size', () => {
  const CHUNK_CHAR_CAP = 256 * 1024;

  class SizeProbe extends LocalEmbedder {
    readonly callChars: number[] = [];
    protected async encode(texts: string[]): Promise<Float32Array[]> {
      let chars = 0;
      for (const text of texts) chars += text.length;
      this.callChars.push(chars);
      return texts.map(() => new Float32Array(this.dims));
    }
  }

  it('splits on characters well before the document count is reached', async () => {
    const embedder = new SizeProbe();
    // 8 documents — a quarter of the document chunk — but 1MB of text.
    const vectors = await embedder.embed(
      Array.from({ length: 8 }, (_, i) => `doc ${i} `.padEnd(128 * 1024, 'x')),
    );

    expect(vectors).toHaveLength(8);
    expect(Math.max(...embedder.callChars)).toBeLessThanOrEqual(CHUNK_CHAR_CAP);
  });

  it('still passes a single oversized document through rather than stalling', async () => {
    const embedder = new SizeProbe();
    const vectors = await embedder.embed([`x`.repeat(CHUNK_CHAR_CAP * 3)]);
    expect(vectors).toHaveLength(1);
    expect(embedder.callChars).toHaveLength(1);
  });
});

/**
 * Regression: countIndexed must answer about the same population query() reads.
 *
 * It was an unscoped COUNT(*) while query() filters on project AND model_id, so
 * "does this scope hold any vectors" was answered from a different set of rows
 * than the search itself would touch. Both halves are user-visible, and the
 * model half reaches all the way out to search: VectorSearchStrategy asks this
 * question to tell an unpopulated index apart from a genuinely empty answer,
 * and a non-zero count made it hand back an authoritative "no matches" for an
 * index it could not read a single vector out of.
 */
describe('VectorIndex.countIndexed scoping', () => {
  function seedTwoProjects(): Database {
    const db = createCorpusDb();
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(2, 'cs-2', 'ms-2', 'beta', 'claude');
    const obs = insertObs(db);
    // beta gets indexed content; alpha has rows and nothing indexed.
    for (let i = 1; i <= 100; i++) {
      obs.run(i, 'ms-2', 'beta', null, null, `beta narrative ${i}`, JSON.stringify([`beta fact ${i}`]), Date.now());
    }
    for (let i = 201; i <= 350; i++) {
      obs.run(i, 'ms-1', 'alpha', null, null, `alpha narrative ${i}`, null, Date.now());
    }
    return db;
  }

  it("does not report another project's vectors as this project's", async () => {
    const db = seedTwoProjects();
    const index = new VectorIndex(db, new FakeEmbedder());
    // Index beta only, leaving alpha's 150 rows with no vectors at all.
    await index.upsert('observation', [
      { docId: 'obs_1_narrative', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'beta narrative 1' },
      { docId: 'obs_2_narrative', sqliteId: 2, fieldType: 'narrative', factIndex: null, text: 'beta narrative 2' },
    ]);

    expect(index.countIndexed('observation', { project: 'beta' })).toBe(2);
    expect(index.countIndexed('observation', { project: 'alpha' })).toBe(0);
  });

  it('does not count vectors written under a model it can no longer read', async () => {
    const db = createCorpusDb();
    seedWideRows(db, 3, 1, 40);
    const old = new VectorIndex(db, new FakeEmbedder());
    const backfill = new VectorBackfill(db, old);
    await drain(backfill, old.modelId, 20);
    expect(old.countIndexed('observation')).toBeGreaterThan(0);

    class OtherModel extends FakeEmbedder {
      readonly modelId = 'test/other-model/384';
    }
    const rebuilt = new VectorIndex(db, new OtherModel());
    expect(rebuilt.countIndexed('observation')).toBe(0);
  });

  /**
   * The same fact one level up, on the path a real search takes: after a model
   * change every vector is unreadable, query() returns nothing, and the strategy
   * has to say so rather than reporting the corpus as holding no match.
   */
  it('lets search tell a stale index apart from an empty answer', async () => {
    const db = createCorpusDb();
    seedWideRows(db, 3, 1, 40);
    const old = new VectorIndex(db, new FakeEmbedder());
    await drain(new VectorBackfill(db, old), old.modelId, 20);

    class OtherModel extends FakeEmbedder {
      readonly modelId = 'test/other-model/384';
    }
    const rebuilt = new VectorIndex(db, new OtherModel());
    const sessionStore = {
      getAllProjects: () => ['alpha'],
      getObservationsByIds: () => [],
      getSessionSummariesByIds: () => [],
      getUserPromptsByIds: () => [],
    };
    const strategy = new VectorSearchStrategy(new VectorSync(rebuilt), sessionStore as any);

    await expect(
      strategy.search({ query: 'narrative 1', searchType: 'observations', project: 'alpha' }),
    ).rejects.toThrow(/not ready|still building|backfill/i);
  });
});
