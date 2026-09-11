// Regression tests for #3890: the v7 session_summaries rebuild
// (removeSessionSummariesUniqueConstraint) recreated the table from a fixed
// v7 column list. Fresh installs stamp every migration at once, so a database
// whose base schema already carried v11's discovery_tokens next to the v7
// UNIQUE constraint lost the column in that rebuild, and the version-11 guard
// (gated on the schema_versions row) never re-added it. Every summary write
// failed with "table session_summaries has no column named discovery_tokens"
// from then on while observations kept being captured.
//
// Fix: the rebuild carries every live column that is not in its v7 list over
// (type and default included), and ensureDiscoveryTokensColumn re-checks the
// live table regardless of the stamped version.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

function createBaseTables(db: Database): void {
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
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-healthy', 'mem-healthy', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
}

/**
 * The reporter's shape: a v4-era database whose session_summaries still has
 * the table-level UNIQUE constraint (so the v7 rebuild will run) but already
 * carries discovery_tokens, with version 11 stamped.
 */
function seedDbWithUniqueConstraintAndDiscoveryTokens(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');
  createBaseTables(db);
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
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  for (const version of [4, 11]) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, discovery_tokens, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'first summary', 42, ?, ?)
  `).run(ISO, EPOCH);
  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

/**
 * A database the old rebuild already ran on: no UNIQUE constraint any more,
 * discovery_tokens gone, versions 7 and 11 stamped. Version 21 is
 * stamped too, so the later session_summaries rebuild (addOnUpdateCascadeToForeignKeys)
 * does not mask the missing column the way it would on a partially
 * migrated database; the reporter's database had every version stamped.
 */
function seedDbThatAlreadyLostTheColumn(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');
  createBaseTables(db);
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
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
  for (const version of [4, 7, 11, 21]) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name);
}

function hasTableLevelUniqueConstraint(db: Database): boolean {
  const indexes = db.query('PRAGMA index_list(session_summaries)').all() as Array<{ unique: number; origin: string }>;
  return indexes.some(idx => idx.unique === 1 && idx.origin === 'u');
}

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe('session_summaries v7 rebuild keeps post-v7 columns (#3890)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-v7-columns-'));
    return path.join(tempDir, 'claude-mem.db');
  }

  it('carries discovery_tokens, its values and its default over the UNIQUE-constraint rebuild', () => {
    const dbPath = makeTempDbPath();
    seedDbWithUniqueConstraintAndDiscoveryTokens(dbPath);

    const store = new SessionStore(dbPath);

    // The rebuild ran: the table-level UNIQUE constraint is gone ...
    expect(hasTableLevelUniqueConstraint(store.db)).toBe(false);
    expect(count(store.db, 'SELECT COUNT(*) AS n FROM schema_versions WHERE version = 7')).toBe(1);
    // ... and the post-v7 column survived it, value included.
    expect(columnNames(store.db, 'session_summaries')).toContain('discovery_tokens');
    const first = store.db.prepare(
      `SELECT discovery_tokens FROM session_summaries WHERE request = 'first summary'`
    ).get() as { discovery_tokens: number };
    expect(first.discovery_tokens).toBe(42);

    // The write that used to fail on every attempt: a second summary for the
    // same session (the reason the UNIQUE constraint was removed), naming the
    // column. The default carried over as well.
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'second summary', 7, ?, ?)
    `).run(ISO, EPOCH + 1);
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'third summary', ?, ?)
    `).run(ISO, EPOCH + 2);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = 'mem-healthy'`)).toBe(3);
    const third = store.db.prepare(
      `SELECT discovery_tokens FROM session_summaries WHERE request = 'third summary'`
    ).get() as { discovery_tokens: number };
    expect(third.discovery_tokens).toBe(0);

    store.db.close();
  });

  it('re-adds discovery_tokens on a database where the old rebuild already dropped it', () => {
    const dbPath = makeTempDbPath();
    seedDbThatAlreadyLostTheColumn(dbPath);

    const store = new SessionStore(dbPath);

    expect(columnNames(store.db, 'session_summaries')).toContain('discovery_tokens');
    expect(columnNames(store.db, 'observations')).toContain('discovery_tokens');
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-healthy', 'proj-a', 'after repair', 3, ?, ?)
    `).run(ISO, EPOCH);
    expect(count(store.db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);

    store.db.close();
  });
});
