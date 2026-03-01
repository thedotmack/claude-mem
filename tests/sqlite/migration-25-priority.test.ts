/**
 * Migration test: ensurePriorityColumn (migration 25)
 *
 * Tests that:
 * 1. Column is added to observations table if missing
 * 2. Default value is 'informational'
 * 3. Migration is idempotent (safe to run twice)
 *
 * RED phase: These tests should FAIL until Step 3 implementation adds
 * ensurePriorityColumn() to MigrationRunner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/services/sqlite/sqlite-compat.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import type { TableColumnInfo } from '../../src/types/database.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal in-memory database with all migrations UP TO (but not
 * including) migration 25, so we can test migration 25 in isolation.
 */
function createPreMigrationDb(): Database {
  const db = new Database(':memory:');

  db.run('PRAGMA foreign_keys = ON');

  // schema_versions table
  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // observations table WITH read_tokens but WITHOUT priority
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      read_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // sdk_sessions table (required for FK and migration checks)
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      failed_at_epoch INTEGER
    )
  `);

  // session_summaries table
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
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // pending_messages table
  db.run(`
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch INTEGER NOT NULL,
      failed_at_epoch INTEGER
    )
  `);

  // user_prompts table
  db.run(`
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // context_injections table (migration 23)
  db.run(`
    CREATE TABLE context_injections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      injection_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // Mark all migrations up to 24 as already applied so runner skips them
  const versions = [4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 19, 20, 21, 23, 24];
  const insertVersion = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  for (const v of versions) {
    insertVersion.run(v, new Date().toISOString());
  }

  return db;
}

function insertObservationWithoutPriority(db: Database): number {
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    'mem-session-test',
    'test-project',
    'discovery',
    'Test observation',
    'Test narrative',
    new Date().toISOString(),
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const tableInfo = db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  return tableInfo.some(col => col.name === column);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensurePriorityColumn migration (version 25)', () => {
  let db: Database;

  beforeEach(() => {
    db = createPreMigrationDb();
  });

  afterEach(() => {
    db.close();
  });

  it('adds priority column to observations table', () => {
    expect(hasColumn(db, 'observations', 'priority')).toBe(false);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(hasColumn(db, 'observations', 'priority')).toBe(true);
  });

  it('records version 25 in schema_versions after migration', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const applied = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(25) as { version: number } | undefined;
    expect(applied).toBeDefined();
    expect(applied?.version).toBe(25);
  });

  it('sets default value of informational for existing rows', () => {
    insertObservationWithoutPriority(db);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare('SELECT priority FROM observations WHERE id = 1').get() as { priority: string };
    expect(row.priority).toBe('informational');
  });

  it('sets default value of informational for newly inserted rows without priority', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Insert row WITHOUT specifying priority — should use column default
    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('mem-new', 'test-project', 'bugfix', 'New obs', new Date().toISOString(), Date.now());

    const row = db.prepare('SELECT priority FROM observations WHERE id = 1').get() as { priority: string };
    expect(row.priority).toBe('informational');
  });

  it('is idempotent — running migrations twice does not fail', () => {
    insertObservationWithoutPriority(db);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const firstRun = db.prepare('SELECT priority FROM observations WHERE id = 1').get() as { priority: string };
    expect(firstRun.priority).toBe('informational');

    // Second run — should be no-op
    runner.runAllMigrations();

    const secondRun = db.prepare('SELECT priority FROM observations WHERE id = 1').get() as { priority: string };
    expect(secondRun.priority).toBe('informational');
  });

  it('allows explicit priority values to be stored', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, priority, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('mem-critical', 'test-project', 'bugfix', 'Critical bug', 'critical', new Date().toISOString(), Date.now());

    const row = db.prepare('SELECT priority FROM observations WHERE id = 1').get() as { priority: string };
    expect(row.priority).toBe('critical');
  });
});
