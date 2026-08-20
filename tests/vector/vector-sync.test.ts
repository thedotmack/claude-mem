import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { FakeEmbedder } from './fake-embedder.js';

const OBSERVATION = {
  type: 'discovery', title: 'race', subtitle: null,
  facts: ['two writers hit the same row', 'the later write won silently'],
  narrative: 'a concurrent write clobbered a peer update',
  concepts: [], files_read: [], files_modified: [],
};

/**
 * The flat pre-v8 shape. `text` is the BASE observations column and predates
 * narrative/facts, so a caller replaying an old row carries it and nothing
 * else; ChromaSync rendered that row as obs_<id>_text.
 */
const LEGACY_OBSERVATION = {
  type: 'discovery', title: null, subtitle: null,
  facts: [], narrative: null,
  text: 'a flat legacy observation about a stale cache read',
  concepts: [], files_read: [], files_modified: [],
};

describe('VectorSync', () => {
  let db: Database;
  let index: VectorIndex;
  let sync: VectorSync;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
            memory_session_id TEXT, project TEXT, platform_source TEXT)`);
    db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT,
            prompt_text TEXT, created_at_epoch INTEGER)`);
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'sess-1', 'alpha', 'claude');
    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(7, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(8, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?)').run(9, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)').run(11, 'cs-1', 'a prompt', Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    sync = new VectorSync(index);
    await sync.syncObservation(7, 'sess-1', 'alpha', OBSERVATION as any, 1, Date.now(), 'claude');
  });

  it('fans an observation out to one document per narrative and fact', () => {
    expect(index.countIndexed('observation')).toBe(3);
  });

  it('keeps document ids byte-identical to the Chroma scheme', () => {
    const ids = (db.prepare('SELECT doc_id FROM vec_observation_docs ORDER BY doc_id')
      .all() as { doc_id: string }[]).map((r) => r.doc_id);
    expect(ids).toEqual(['obs_7_fact_0', 'obs_7_fact_1', 'obs_7_narrative']);
  });

  it('is idempotent when re-syncing unchanged content', async () => {
    const before = index.countIndexed('observation');
    await sync.syncObservation(7, 'sess-1', 'alpha', OBSERVATION as any, 1, Date.now(), 'claude');
    expect(index.countIndexed('observation')).toBe(before);
  });

  it('indexes only the populated summary fields', async () => {
    await sync.syncSummary(9, 'sess-1', 'alpha', {
      request: 'fix the lost update', investigated: 'traced the write path',
      learned: null, completed: null, next_steps: null, notes: null,
    } as any, 1, Date.now(), 'claude');
    expect(index.countIndexed('summary')).toBe(2);
  });

  it('indexes a user prompt', async () => {
    await sync.syncUserPrompt(11, 'sess-1', 'alpha', 'how do agents avoid clobbering', 1, Date.now(), 'claude');
    expect(index.countIndexed('prompt')).toBe(1);
  });

  it('emits obs_<id>_text for an observation carrying the legacy text field', async () => {
    await sync.syncObservation(8, 'sess-1', 'alpha', LEGACY_OBSERVATION as any, 1, Date.now(), 'claude');
    const ids = (db.prepare('SELECT doc_id FROM vec_observation_docs WHERE sqlite_id = 8')
      .all() as { doc_id: string }[]).map((r) => r.doc_id);
    expect(ids).toEqual(['obs_8_text']);
  });

  it('makes a legacy text observation retrievable', async () => {
    const hits = await index.query({
      text: 'a flat legacy observation about a stale cache read',
      kinds: ['observation'], project: 'alpha', limit: 3,
    });
    expect(hits[0].sqliteId).toBe(8);
    expect(hits[0].fieldType).toBe('text');
  });

  it('makes written documents retrievable', async () => {
    const hits = await index.query({
      text: 'a concurrent write clobbered a peer update',
      kinds: ['observation'], project: 'alpha', limit: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sqliteId).toBe(7);
  });
});
