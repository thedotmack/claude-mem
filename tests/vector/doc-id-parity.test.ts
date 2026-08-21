import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { FakeEmbedder } from './fake-embedder.js';

/**
 * The live write path and the one-time backfill index the same rows, so they
 * must mint the same doc_id for the same document. They are separate renderers
 * (VectorSync.syncSummary vs VectorBackfill.toDocs), which is exactly the shape
 * that lets the two drift apart unnoticed: nothing joins on doc_id, so a
 * divergence shows up only as a duplicate row for one document and as a broken
 * promise of continuity with the ids Chroma wrote.
 *
 * The expected strings are the ids ChromaSync emitted on main
 * (src/services/sync/ChromaSync.ts): summary_<id>_<field> and prompt_<id>.
 */
function createDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
          memory_session_id TEXT, project TEXT, platform_source TEXT)`);
  db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, text TEXT, narrative TEXT, facts TEXT,
          created_at_epoch INTEGER)`);
  db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
          project TEXT, merged_into_project TEXT, request TEXT, learned TEXT,
          created_at_epoch INTEGER)`);
  db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER,
          content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER,
          FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE)`);
  db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'ms-1', 'alpha', 'claude');
  db.prepare(`INSERT INTO session_summaries
    (id, memory_session_id, project, merged_into_project, request, learned, created_at_epoch)
    VALUES (?,?,?,?,?,?,?)`)
    .run(7, 'ms-1', 'alpha', null, 'the request text', 'the learned text', Date.now());
  db.prepare(`INSERT INTO user_prompts
    (id, session_db_id, content_session_id, prompt_text, created_at_epoch)
    VALUES (?,?,?,?,?)`)
    .run(11, 1, 'cs-1', 'a prompt about shared state', Date.now());
  return db;
}

const docIds = (db: Database, table: string): string[] =>
  (db.prepare(`SELECT doc_id FROM ${table} ORDER BY doc_id`).all() as { doc_id: string }[])
    .map((r) => r.doc_id);

describe('doc id parity between the live write path and the backfill', () => {
  let backfilled: { summary: string[]; prompt: string[] };
  let live: { summary: string[]; prompt: string[] };

  beforeAll(async () => {
    const backfillDb = createDb();
    const backfillIndex = new VectorIndex(backfillDb, new FakeEmbedder());
    await new VectorBackfill(backfillDb, backfillIndex).runBatch(['summary', 'prompt']);
    backfilled = {
      summary: docIds(backfillDb, 'vec_summary_docs'),
      prompt: docIds(backfillDb, 'vec_prompt_docs'),
    };

    const liveDb = createDb();
    const sync = new VectorSync(new VectorIndex(liveDb, new FakeEmbedder()));
    await sync.syncSummary(7, 'ms-1', 'alpha', {
      request: 'the request text',
      investigated: null,
      learned: 'the learned text',
      completed: null,
      next_steps: null,
      notes: null,
    } as never, 1, Date.now());
    await sync.syncUserPrompt(11, 'ms-1', 'alpha', 'a prompt about shared state', 1, Date.now());
    live = {
      summary: docIds(liveDb, 'vec_summary_docs'),
      prompt: docIds(liveDb, 'vec_prompt_docs'),
    };
  });

  it('mints the ChromaSync summary id from both paths', () => {
    expect(backfilled.summary).toEqual(['summary_7_learned', 'summary_7_request']);
    expect(live.summary).toEqual(backfilled.summary);
  });

  it('mints the ChromaSync prompt id from both paths', () => {
    expect(backfilled.prompt).toEqual(['prompt_11']);
    expect(live.prompt).toEqual(backfilled.prompt);
  });
});
