import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import { FakeEmbedder } from './fake-embedder.js';

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
