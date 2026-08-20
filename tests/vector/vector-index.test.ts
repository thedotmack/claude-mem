import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { FakeEmbedder } from './fake-embedder.js';
import type { VectorHit } from '../../src/services/vector/types.js';

/**
 * The fixture mirrors the REAL column layout, including where scope actually
 * lives: observations and session_summaries carry `project` themselves and
 * reach platform_source through sdk_sessions.memory_session_id, while
 * user_prompts carry neither and reach both through
 * sdk_sessions.content_session_id.
 *
 * An earlier version of this file invented a flat schema where every table had
 * every column. It passed while prompt scoping was querying columns that do not
 * exist, so the shape here is load-bearing, not incidental.
 */
describe('VectorIndex', () => {
  let db: Database;
  let index: VectorIndex;
  let ranked: VectorHit[];

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
            memory_session_id TEXT, project TEXT, platform_source TEXT)`);
    // `text` is the BASE observations column (NOT NULL until schema v9);
    // narrative/facts only arrive at v8. A fixture without it cannot represent
    // a pre-v8 row, which is most of an upgrading install's corpus.
    db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, text TEXT, narrative TEXT, facts TEXT,
            created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT,
            prompt_text TEXT, created_at_epoch INTEGER)`);

    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-a', 'ms-a', 'alpha', 'claude');
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(2, 'cs-b', 'ms-b', 'beta', 'codex');
    const obs = db.prepare(`INSERT INTO observations
      (id, memory_session_id, project, merged_into_project, text, narrative, facts, created_at_epoch)
      VALUES (?,?,?,?,?,?,?,?)`);
    obs.run(1, 'ms-a', 'alpha', null, null, 'n1', null, Date.now());
    obs.run(2, 'ms-a', 'alpha', null, null, 'n2', null, Date.now());
    obs.run(3, 'ms-b', 'beta', null, null, 'n3', null, Date.now());
    obs.run(4, 'ms-b', 'legacy', 'alpha', null, 'n4', null, Date.now()); // remapped into alpha
    // Pre-v8 shape: only the flat text column was ever written.
    obs.run(5, 'ms-a', 'alpha', null, 'a flat legacy row about a stale cache read', null, null, Date.now());
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)').run(10, 'cs-a', 'p', Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    await index.upsert('observation', [
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null,
        text: 'lost update when two writers race on one file' },
      { docId: 'obs_2_n', sqliteId: 2, fieldType: 'narrative', factIndex: null,
        text: 'gradient styling for a marketing page header' },
      { docId: 'obs_3_n', sqliteId: 3, fieldType: 'narrative', factIndex: null,
        text: 'concurrent writers clobbered a shared store during a migration' },
      { docId: 'obs_4_n', sqliteId: 4, fieldType: 'narrative', factIndex: null,
        text: 'a remapped project row touched by two writers' },
    ]);
    await index.upsert('prompt', [
      { docId: 'pr_10', sqliteId: 10, fieldType: 'prompt_text', factIndex: null,
        text: 'how do I stop two agents overwriting each other' },
    ]);
    // Shares every token with obs_1_n and none with obs_2_n, so the expected
    // ordering follows from the fake embedder's token-overlap metric.
    ranked = await index.query({
      text: 'lost update when two writers race on one file', kinds: ['observation'], limit: 4,
    });
  });

  it('ranks the semantically relevant document first', () => {
    expect(ranked[0].docId).toBe('obs_1_n');
  });

  it('returns hits ordered by descending similarity', () => {
    // The contract under test is the ranking, not the embedder's judgement:
    // asserting which specific low-overlap document lands last would be
    // testing the fixture's hash collisions rather than this code.
    const scores = ranked.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(scores[scores.length - 1]);
  });

  it('scopes by project, excluding other projects', async () => {
    const hits = await index.query({
      text: 'concurrent writers', kinds: ['observation'], project: 'beta', limit: 5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].sqliteId).toBe(3);
  });

  it('honours merged_into_project, as the Chroma $or filter did', async () => {
    const hits = await index.query({
      text: 'racing writes', kinds: ['observation'], project: 'alpha', limit: 9,
    });
    expect(hits.some((h) => h.sqliteId === 4)).toBe(true);
  });

  it('resolves platform_source across the sdk_sessions join', async () => {
    // platform_source is not a column on observations; it is only reachable
    // through sdk_sessions, which is what this asserts.
    const hits = await index.query({
      text: 'writers', kinds: ['observation'], platformSource: 'codex', limit: 9,
    });
    expect(hits.every((h) => h.sqliteId === 3 || h.sqliteId === 4)).toBe(true);
  });

  it('scopes prompts through sdk_sessions.content_session_id', async () => {
    const hits = await index.query({
      text: 'agents overwriting', kinds: ['prompt'], project: 'alpha', limit: 3,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].sqliteId).toBe(10);
  });

  it('excludes a prompt from the wrong project', async () => {
    const hits = await index.query({
      text: 'agents overwriting', kinds: ['prompt'], project: 'beta', limit: 3,
    });
    expect(hits.length).toBe(0);
  });

  it('indexes and retrieves a pre-v8 text document', async () => {
    await index.upsert('observation', [
      { docId: 'obs_5_text', sqliteId: 5, fieldType: 'text', factIndex: null,
        text: 'a flat legacy row about a stale cache read' },
    ]);
    const hits = await index.query({
      text: 'a flat legacy row about a stale cache read',
      kinds: ['observation'], project: 'alpha', limit: 3,
    });
    expect(hits[0].docId).toBe('obs_5_text');
    expect(hits[0].fieldType).toBe('text');
  });

  it('does not re-embed unchanged text', async () => {
    const written = await index.upsert('observation', [
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null,
        text: 'lost update when two writers race on one file' },
    ]);
    expect(written).toBe(0);
  });

  it('re-embeds when the text changes', async () => {
    const written = await index.upsert('observation', [
      { docId: 'obs_2_n', sqliteId: 2, fieldType: 'narrative', factIndex: null,
        text: 'completely different content now' },
    ]);
    expect(written).toBe(1);
  });

  it('cascades vectors when the parent row is deleted', () => {
    const before = index.countIndexed('observation');
    db.run('DELETE FROM observations WHERE id = 3');
    expect(index.countIndexed('observation')).toBe(before - 1);
  });
});

/**
 * A parent row and its vector documents are a set: the backfill's NOT EXISTS
 * predicate is satisfied by the FIRST vector row for a parent, so a parent
 * left half-written is never revisited. These fixtures build their own
 * database because they deliberately provoke write failures.
 */
function freshDb(options: { withPrompts?: boolean } = {}): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
          memory_session_id TEXT, project TEXT, platform_source TEXT)`);
  db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, text TEXT, narrative TEXT, facts TEXT,
          created_at_epoch INTEGER)`);
  db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
  if (options.withPrompts !== false) {
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT,
            prompt_text TEXT, created_at_epoch INTEGER)`);
  }
  db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-a', 'ms-a', 'alpha', 'claude');
  const obs = db.prepare(`INSERT INTO observations
    (id, memory_session_id, project, merged_into_project, text, narrative, facts, created_at_epoch)
    VALUES (?,?,?,?,?,?,?,?)`);
  obs.run(1, 'ms-a', 'alpha', null, null, 'n1', null, Date.now());
  obs.run(2, 'ms-a', 'alpha', null, null, 'n2', null, Date.now());
  return db;
}

function docsFor(db: Database, sqliteId: number): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM vec_observation_docs WHERE sqlite_id = ?',
  ).get(sqliteId) as { n: number };
  return row.n;
}

describe('VectorIndex per-parent write atomicity', () => {
  it('leaves a parent with zero documents when one of its documents fails', async () => {
    const db = freshDb();
    const index = new VectorIndex(db, new FakeEmbedder());

    const attempt = index.upsert('observation', [
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'one' },
      { docId: 'obs_2_n', sqliteId: 2, fieldType: 'narrative', factIndex: null, text: 'two' },
      // NOT NULL on field_type: this row cannot be inserted, so parent 2 must
      // end up with NO documents rather than a half-written set that the
      // backfill would then treat as already indexed.
      { docId: 'obs_2_f0', sqliteId: 2, fieldType: null as unknown as string, factIndex: 0, text: 'three' },
    ]);

    await expect(attempt).rejects.toThrow();
    expect(docsFor(db, 2)).toBe(0);
    // Parents written before the failure keep their documents.
    expect(docsFor(db, 1)).toBe(1);
    db.close();
  });

  it('skips a vanished parent without aborting the rest of the batch', async () => {
    const db = freshDb();
    const index = new VectorIndex(db, new FakeEmbedder());

    // sqlite_id 404 was deleted between the backfill SELECT and this INSERT.
    const written = await index.upsert('observation', [
      { docId: 'obs_404_n', sqliteId: 404, fieldType: 'narrative', factIndex: null, text: 'gone' },
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'one' },
      { docId: 'obs_1_f0', sqliteId: 1, fieldType: 'fact', factIndex: 0, text: 'one fact' },
    ]);

    expect(written).toBe(2);
    expect(docsFor(db, 1)).toBe(2);
    expect(docsFor(db, 404)).toBe(0);
    db.close();
  });
});

describe('VectorIndex read-side resilience', () => {
  it('skips malformed embedding blobs instead of failing the whole scope', async () => {
    const db = freshDb();
    const index = new VectorIndex(db, new FakeEmbedder());
    await index.upsert('observation', [
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'stale cache read' },
      { docId: 'obs_2_n', sqliteId: 2, fieldType: 'narrative', factIndex: null, text: 'stale cache read' },
    ]);
    const corrupt = db.prepare('UPDATE vec_observation_docs SET embedding = ? WHERE doc_id = ?');
    // Right float alignment, wrong dimensionality: dot() would walk off the
    // end and score NaN, which sorts unpredictably against every real hit.
    corrupt.run(new Uint8Array(8), 'obs_2_n');

    const hits = await index.query({ text: 'stale cache read', kinds: ['observation'], limit: 5 });
    expect(hits.map((h) => h.docId)).toEqual(['obs_1_n']);
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);

    // Not even a whole number of float32s: decoding throws outright.
    corrupt.run(new Uint8Array(7), 'obs_2_n');
    const again = await index.query({ text: 'stale cache read', kinds: ['observation'], limit: 5 });
    expect(again.map((h) => h.docId)).toEqual(['obs_1_n']);
    db.close();
  });

  it('skips a kind whose parent table does not exist', async () => {
    const db = freshDb({ withPrompts: false });
    const index = new VectorIndex(db, new FakeEmbedder());
    await index.upsert('observation', [
      { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'two writers race' },
    ]);

    const hits = await index.query({
      text: 'two writers race', kinds: ['observation', 'prompt'], limit: 5,
    });
    expect(hits.map((h) => h.docId)).toEqual(['obs_1_n']);
    db.close();
  });
});
