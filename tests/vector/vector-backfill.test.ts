import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import { FakeEmbedder } from './fake-embedder.js';

describe('VectorBackfill', () => {
  let db: Database;
  let index: VectorIndex;
  let backfill: VectorBackfill;
  let startedIncomplete: boolean;
  let passes = 0;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
            memory_session_id TEXT, project TEXT, platform_source TEXT)`);
    db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, narrative TEXT, facts TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, request TEXT, learned TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT,
            prompt_text TEXT, created_at_epoch INTEGER)`);
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'ms-1', 'alpha', 'claude');

    // A pre-existing corpus, as an upgrading install would have.
    const obs = db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?,?)');
    for (let i = 1; i <= 5; i++) {
      obs.run(i, 'ms-1', 'alpha', null, `narrative number ${i} about shared state`,
        JSON.stringify([`fact a${i}`, `fact b${i}`]), Date.now());
    }
    // Malformed facts JSON must not stall a migration that touches every row.
    obs.run(6, 'ms-1', 'alpha', null, 'narrative six', '{not valid json', Date.now());
    db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?,?,?)')
      .run(1, 'ms-1', 'alpha', null, 'the request', 'the lesson', Date.now());
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)')
      .run(1, 'cs-1', 'how do agents avoid clobbering', Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    backfill = new VectorBackfill(db, index);

    startedIncomplete = !backfill.isComplete(index.modelId);
    while (!backfill.isComplete(index.modelId) && passes++ < 20) {
      await backfill.runBatch();
    }
  });

  it('reports incomplete before running', () => {
    expect(startedIncomplete).toBe(true);
  });

  it('reaches completion', () => {
    expect(backfill.isComplete(index.modelId)).toBe(true);
  });

  it('embeds every observation document', () => {
    // 5 rows x (1 narrative + 2 facts) + row 6 narrative only (bad JSON) = 16
    expect(index.countIndexed('observation')).toBe(16);
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
