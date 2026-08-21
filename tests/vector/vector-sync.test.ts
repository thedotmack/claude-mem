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
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER,
            content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER)`);
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'sess-1', 'alpha', 'claude');
    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(7, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(8, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?)').run(9, 'sess-1', 'alpha', null, Date.now());
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?,?)').run(11, 1, 'cs-1', 'a prompt', Date.now());

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

  it('keeps summary document ids byte-identical to the Chroma scheme', () => {
    const ids = (db.prepare('SELECT doc_id FROM vec_summary_docs ORDER BY doc_id')
      .all() as { doc_id: string }[]).map((r) => r.doc_id);
    expect(ids).toEqual(['summary_9_investigated', 'summary_9_request']);
  });

  it('indexes a user prompt', async () => {
    await sync.syncUserPrompt(11, 'sess-1', 'alpha', 'how do agents avoid clobbering', 1, Date.now(), 'claude');
    expect(index.countIndexed('prompt')).toBe(1);
  });

  it('keeps prompt document ids byte-identical to the Chroma scheme', () => {
    const ids = (db.prepare('SELECT doc_id FROM vec_prompt_docs ORDER BY doc_id')
      .all() as { doc_id: string }[]).map((r) => r.doc_id);
    expect(ids).toEqual(['prompt_11']);
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

describe('VectorSync scope joins', () => {
  let db: Database;
  let index: VectorIndex;
  let sync: VectorSync;

  const PROMPT_TEXT = 'why did the follower reject the append entries call';
  const OBS_TEXT = 'the follower rejected an append entries call from a stale leader';
  const ORPHAN_TEXT = 'a snapshot install truncated the log below the commit index';

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT,
            memory_session_id TEXT, project TEXT, platform_source TEXT)`);
    db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT,
            project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER,
            content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER)`);

    // Two sessions share one content_session_id. That is legal: the only
    // uniqueness sdk_sessions carries is ux_sdk_sessions_platform_content, on
    // (platform_source, content_session_id). Session 1 is also the pre-COALESCE
    // shape: platform_source NULL, which the rest of the store reads as claude.
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-dup', 'sess-a', 'alpha', null);
    db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(2, 'cs-dup', 'sess-b', 'beta', 'codex');

    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(20, 'sess-a', 'alpha', null, Date.now());
    // No sdk_sessions row at all, which getObservationsByIds also reads as the
    // default source because it LEFT JOINs and coalesces the same way.
    db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(21, 'sess-orphan', 'alpha', null, Date.now());
    // session_db_id is the migrated key (schema v34); content_session_id is the
    // legacy copy the rebuild carried over and which now matches two sessions.
    db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?,?)').run(30, 1, 'cs-dup', PROMPT_TEXT, Date.now());

    index = new VectorIndex(db, new FakeEmbedder());
    sync = new VectorSync(index);
    await sync.syncObservation(20, 'sess-a', 'alpha', {
      type: 'discovery', title: null, subtitle: null, facts: [],
      narrative: OBS_TEXT, concepts: [], files_read: [], files_modified: [],
    } as any, 1, Date.now(), 'claude');
    await sync.syncObservation(21, 'sess-orphan', 'alpha', {
      type: 'discovery', title: null, subtitle: null, facts: [],
      narrative: ORPHAN_TEXT, concepts: [], files_read: [], files_modified: [],
    } as any, 1, Date.now(), 'claude');
    await sync.syncUserPrompt(30, 'sess-a', 'alpha', PROMPT_TEXT, 1, Date.now(), 'claude');
  });

  it('treats a NULL platform_source as claude, as the rest of the store does', async () => {
    const hits = await index.query({
      text: OBS_TEXT, kinds: ['observation'], project: 'alpha',
      platformSource: 'claude', limit: 5,
    });
    expect(hits.map((h) => h.sqliteId)).toContain(20);
  });

  it('keeps an observation whose session row is absent inside the default source', async () => {
    const hits = await index.query({
      text: ORPHAN_TEXT, kinds: ['observation'], project: 'alpha',
      platformSource: 'claude', limit: 5,
    });
    expect(hits.map((h) => h.sqliteId)).toContain(21);
  });

  it('scopes a prompt by its session_db_id session, not a content_session_id twin', async () => {
    const hits = await index.query({
      text: PROMPT_TEXT, kinds: ['prompt'], project: 'beta', limit: 5,
    });
    expect(hits).toEqual([]);
  });

  it('yields one hit per prompt document when content_session_id is ambiguous', async () => {
    const hits = await index.query({ text: PROMPT_TEXT, kinds: ['prompt'], limit: 5 });
    expect(hits.map((h) => h.sqliteId)).toEqual([30]);
  });

  it('scopes a prompt by platform through its own session', async () => {
    const hits = await index.query({
      text: PROMPT_TEXT, kinds: ['prompt'], project: 'alpha',
      platformSource: 'claude', limit: 5,
    });
    expect(hits.map((h) => h.sqliteId)).toEqual([30]);
  });
});
