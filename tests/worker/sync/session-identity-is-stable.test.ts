// A session's memory_session_id is its IDENTITY, not a per-turn value.
//
// It is the FK parent key of `observations` and `session_summaries`, declared
// ON UPDATE CASCADE, and it is the join field `requeuePromptSync` pushes to
// replicas. Changing it is therefore not a field update: it rewrites every
// memory the session owns and re-enqueues every prompt it has.
//
// `ensureMemorySessionIdRegistered` used to write whenever the offered id
// DIFFERED from the stored one, and its busiest caller offers a different one
// every turn — ClaudeProvider starts a fresh SDK process per query(), and
// `resetCarriedMemorySessionId` clears the in-memory copy before each one. So a
// method whose name means "make sure one exists" re-identified the session on
// every turn, and `requeuePromptSync` — whose own docstring describes a one-time
// repair, "Once the mapping lands" — ran once per turn per prompt.
//
// MEASURED on one real store before this change:
//
//   1,100,783 sync_outbox rows for 6,930 distinct prompts  =  158.8x
//   393 MB of an 854 MB database, in a table nothing drains
//   worst single prompt: 3,464 rows carrying 3,464 DISTINCT memory_session_ids
//
// Nothing consumes a later turn's id. `shouldResume` in ClaudeProvider is a
// hardcoded false and every read of it is a log line or a ternary that can only
// take the false branch, so `resume` never receives it; the remaining readers
// are log lines and `buildSummaryPrompt` metadata.
//
// Related and already fixed: #3628 stopped the same caller writing NULL over the
// id at generator start, which cascaded NULL into a NOT NULL child and took the
// whole generator run down with it. This is the other half — the write that
// succeeds, and costs.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const ISO = '2026-09-11T00:00:00.000Z';
const EPOCH = 1757548800000;

function outboxCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n;
}

function storedId(db: Database): string | null {
  return (db.prepare('SELECT memory_session_id AS id FROM sdk_sessions WHERE id = 1').get() as { id: string | null }).id;
}

function addObservation(db: Database, memorySessionId: string): void {
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES (?, 'proj-x', 'a memory', 'discovery', ?, ?)
  `).run(memorySessionId, ISO, EPOCH);
}

describe('a session keeps the identity it was given', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES ('sess-1', NULL, 'proj-x', 'claude', ?, ?, 'active')
    `).run(ISO, EPOCH);
    for (let n = 1; n <= 4; n++) {
      db.prepare(`
        INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
        VALUES (1, 'sess-1', ?, ?, ?, ?, 111)
      `).run(n, `prompt ${n}`, ISO, EPOCH);
    }
  });

  afterEach(() => db.close());

  it('registers an id that is missing, and repairs each prompt once', () => {
    store.ensureMemorySessionIdRegistered(1, 'msid-A');

    expect(storedId(db)).toBe('msid-A');
    expect(outboxCount(db)).toBe(4); // the one-time repair: one op per prompt
  });

  it('re-registering the same id is free', () => {
    store.ensureMemorySessionIdRegistered(1, 'msid-A');
    const afterFirst = outboxCount(db);

    for (let i = 0; i < 10; i++) store.ensureMemorySessionIdRegistered(1, 'msid-A');

    expect(outboxCount(db)).toBe(afterFirst);
  });

  it('refuses to re-register a session that already has an identity', () => {
    // The regression. Ten turns, ten SDK session ids, the shape ClaudeProvider
    // produces. Before this change each one rewrote the session's identity and
    // re-enqueued all four prompts: 40 ops instead of 4.
    store.ensureMemorySessionIdRegistered(1, 'msid-A');
    addObservation(db, 'msid-A');
    const afterFirst = outboxCount(db);

    for (let turn = 0; turn < 10; turn++) {
      store.ensureMemorySessionIdRegistered(1, `msid-turn-${turn}`);
    }

    expect(outboxCount(db)).toBe(afterFirst);
    expect(storedId(db)).toBe('msid-A');
    // And the memory still hangs off the identity it was written under.
    const observed = (db.prepare('SELECT memory_session_id AS id FROM observations').get() as { id: string }).id;
    expect(observed).toBe('msid-A');
  });

  it('a deliberate change is still available, and shows what it costs', () => {
    // `updateMemorySessionId` is the route for a genuine re-identification, and
    // this pins the price so anything that starts calling it per turn has a
    // number to be measured against instead of a 393 MB table nobody looks at.
    store.ensureMemorySessionIdRegistered(1, 'msid-A');
    addObservation(db, 'msid-A');
    const afterFirst = outboxCount(db);

    store.updateMemorySessionId(1, 'msid-B');

    expect(storedId(db)).toBe('msid-B');
    // Supersede, don't append: the repair still runs for every prompt, but
    // replaces the queued set_prompt_session op per target. Cost stays one
    // row per prompt, not afterFirst + 4.
    expect(outboxCount(db)).toBe(afterFirst);
    // ON UPDATE CASCADE carried the change into the memory too.
    const observed = (db.prepare('SELECT memory_session_id AS id FROM observations').get() as { id: string }).id;
    expect(observed).toBe('msid-B');
  });

  it('a session with no prompts registers without emitting anything', () => {
    db.prepare('DELETE FROM user_prompts').run();

    store.ensureMemorySessionIdRegistered(1, 'msid-A');

    expect(storedId(db)).toBe('msid-A');
    expect(outboxCount(db)).toBe(0);
  });
});
