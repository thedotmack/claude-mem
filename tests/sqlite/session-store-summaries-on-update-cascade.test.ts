// Pin-down + regression tests for a session_summaries FK left without
// ON UPDATE CASCADE while its sibling observations FK has it.
//
// How a database reaches that state: v21 (addOnUpdateCascadeToForeignKeys)
// rebuilds observations and session_summaries and stamps ONE schema_versions
// row for both. A database that recorded 21 under a build whose v21 did not
// yet rebuild session_summaries keeps the old declaration for good - the
// version gate reports the work as done, so the rebuild never runs again.
// The seed below reproduces it through the project's own migration chain: v7
// (removeSessionSummariesUniqueConstraint) recreates session_summaries and v9
// (makeObservationsTextNullable) recreates observations, both with ON DELETE
// CASCADE only, and a pre-stamped 21 means nothing ever adds the update half
// back to either. So the stamped ledger can leave one table or both without
// it - which is why the repair checks both halves of the pair rather than the
// one the field report named.
//
// Faulting mechanism these tests pin: ensureMemorySessionIdRegistered
// re-points sdk_sessions.memory_session_id every time the worker captures a
// fresh SDK id (#817 discards the stale one on each worker restart).
// observations follow the parent key, session_summaries rows do not, and
// SQLite aborts the UPDATE with 'FOREIGN KEY constraint failed'. Every
// session that already owns a summary row then fails before storing
// anything, is torn down, is re-initialised by the next observation and
// fails again - an observer crash loop that only ends when the schema is
// repaired.
//
// The fix gates on the constraint itself (PRAGMA foreign_key_list) instead of
// on the schema_versions ledger, and checks both halves of the pair.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

function sessionParentFk(db: Database, table: string): ForeignKeyRow | undefined {
  return (db.query(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyRow[])
    .find(fk => fk.table === 'sdk_sessions' && fk.to === 'memory_session_id');
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * A v4-era database - the shape initializeSchema() creates, stamped at 4 -
 * carrying one session with a summary and an observation, and additionally
 * stamped at 21 so the migration chain replays v7's session_summaries rebuild
 * (ON DELETE CASCADE only) and then skips the v21 repair.
 */
function seedDbWithV21Stamped(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');

  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
    )
  `);
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  const stamp = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  stamp.run(4, ISO);
  // The half-reported repair: 21 on the ledger, only observations rebuilt.
  stamp.run(21, ISO);

  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-a', 'mem-stale', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES ('mem-stale', 'proj-a', 'observation text', 'discovery', ?, ?)
  `).run(ISO, EPOCH);
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES ('mem-stale', 'proj-a', 'summary request', ?, ?)
  `).run(ISO, EPOCH);

  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

describe('session_summaries FK left without ON UPDATE CASCADE by a half-reported v21', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-summaries-cascade-'));
    return path.join(tempDir, 'claude-mem.db');
  }

  it('pins the faulting mechanism: without the update half, re-pointing the parent key aborts', () => {
    const db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE
      )
    `);
    db.run(`
      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    db.run(`INSERT INTO sdk_sessions (memory_session_id) VALUES ('mem-stale')`);
    db.run(`INSERT INTO observations (memory_session_id) VALUES ('mem-stale')`);

    // The cascading sibling alone survives a re-point.
    db.run(`UPDATE sdk_sessions SET memory_session_id = 'mem-fresh' WHERE id = 1`);
    expect(
      (db.prepare('SELECT memory_session_id AS m FROM observations WHERE id = 1').get() as { m: string }).m
    ).toBe('mem-fresh');

    // Add a summary row and the same re-point now aborts: this is the error
    // the observer reports as 'Generator failed {error=FOREIGN KEY constraint failed}'.
    db.run(`INSERT INTO session_summaries (memory_session_id) VALUES ('mem-fresh')`);
    expect(() => {
      db.run(`UPDATE sdk_sessions SET memory_session_id = 'mem-fresher' WHERE id = 1`);
    }).toThrow(/FOREIGN KEY constraint failed/);

    db.close();
  });

  it('repairs a database that recorded v21 with only the observations half applied', () => {
    const dbPath = makeTempDbPath();
    seedDbWithV21Stamped(dbPath);

    // Unfixed code: the chain leaves session_summaries on ON DELETE CASCADE
    // only, because 21 is already on the ledger.
    const store = new SessionStore(dbPath);

    expect(sessionParentFk(store.db, 'session_summaries')?.on_update).toBe('CASCADE');
    expect(sessionParentFk(store.db, 'session_summaries')?.on_delete).toBe('CASCADE');

    // The production call that used to abort, through the real code path.
    const sessionDbId = (store.db.prepare(
      `SELECT id FROM sdk_sessions WHERE content_session_id = 'content-a'`
    ).get() as { id: number }).id;

    expect(() => store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-fresh')).not.toThrow();

    // Both children followed the parent key.
    expect(count(store.db, `SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = 'mem-fresh'`)).toBe(1);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'mem-fresh'`)).toBe(1);

    store.db.close();
  });

  it('carries rows, indexes and triggers across the rebuild', () => {
    const dbPath = makeTempDbPath();
    seedDbWithV21Stamped(dbPath);

    const store = new SessionStore(dbPath);

    expect(count(store.db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);
    const summary = store.db.prepare(
      'SELECT project, request, created_at_epoch FROM session_summaries WHERE id = 1'
    ).get() as { project: string; request: string; created_at_epoch: number };
    expect(summary.project).toBe('proj-a');
    expect(summary.request).toBe('summary request');
    expect(summary.created_at_epoch).toBe(EPOCH);

    // Every index and trigger the chain put on the table is still attached.
    const attached = store.db.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE tbl_name = 'session_summaries' AND sql IS NOT NULL AND type IN ('index', 'trigger')
    `).get() as { n: number };
    expect(attached.n).toBeGreaterThan(0);
    expect(count(store.db, `
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'session_summaries'
        AND name = 'idx_session_summaries_sdk_session'
    `)).toBe(1);

    // AUTOINCREMENT keeps counting from where the copied rows left off.
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-stale', 'proj-a', 'second summary', ?, ?)
    `).run(ISO, EPOCH + 1);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM session_summaries WHERE id = 1`)).toBe(1);

    store.db.close();
  });

  it('is idempotent, and leaves an already-cascading observations table untouched', () => {
    const dbPath = makeTempDbPath();
    seedDbWithV21Stamped(dbPath);

    const first = new SessionStore(dbPath);
    const observationsDDL = (first.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'`
    ).get() as { sql: string }).sql;
    const summariesDDL = (first.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`
    ).get() as { sql: string }).sql;
    first.db.close();

    const second = new SessionStore(dbPath);
    // A second boot rewrites nothing: the constraint gate is already satisfied.
    expect((second.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'`
    ).get() as { sql: string }).sql).toBe(observationsDDL);
    expect((second.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`
    ).get() as { sql: string }).sql).toBe(summariesDDL);
    expect(count(second.db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);
    expect(count(second.db, 'SELECT COUNT(*) AS n FROM observations')).toBe(1);
    expect(sessionParentFk(second.db, 'observations')?.on_update).toBe('CASCADE');

    // No temporary table was left behind by either boot.
    expect(count(second.db, `
      SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_on_update_cascade'
    `)).toBe(0);

    second.db.close();
  });
});
