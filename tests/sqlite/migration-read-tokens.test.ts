/**
 * Migration test: ensureReadTokensColumn (migration 21)
 *
 * Tests that:
 * 1. Column is added to observations table if missing
 * 2. Backfill computes correct token estimates from existing rows
 * 3. Migration is idempotent (safe to run twice)
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
 * including) migration 21, so we can test migration 21 in isolation.
 *
 * We build the schema manually to ensure a known pre-migration state.
 */
function createPreMigrationDb(): Database {
  const db = new Database(':memory:');

  // Basic pragmas
  db.run('PRAGMA foreign_keys = ON');

  // schema_versions table
  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // observations table WITHOUT read_tokens column
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

  // session_summaries table (required for migration checks)
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

  // pending_messages table (required for migration checks)
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

  // user_prompts table (required for migration checks)
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

  // Mark migrations 4–20 as already applied so runner skips them
  const versions = [4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 19, 20];
  const insertVersion = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  for (const v of versions) {
    insertVersion.run(v, new Date().toISOString());
  }

  return db;
}

/**
 * Insert a raw observation row without read_tokens (simulates pre-migration data)
 */
function insertObservationWithoutReadTokens(
  db: Database,
  opts: {
    narrative?: string | null;
    title?: string | null;
    facts?: string | null;
    concepts?: string | null;
    text?: string | null;
  } = {}
): number {
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, facts, concepts, text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    'mem-session-test',
    'test-project',
    'discovery',
    opts.title ?? null,
    opts.narrative ?? null,
    opts.facts ?? null,
    opts.concepts ?? null,
    opts.text ?? null,
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

describe('ensureReadTokensColumn migration (version 21)', () => {
  let db: Database;

  beforeEach(() => {
    db = createPreMigrationDb();
  });

  afterEach(() => {
    db.close();
  });

  it('adds read_tokens column to observations table', () => {
    expect(hasColumn(db, 'observations', 'read_tokens')).toBe(false);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(hasColumn(db, 'observations', 'read_tokens')).toBe(true);
  });

  it('records version 21 in schema_versions after migration', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const applied = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(21) as { version: number } | undefined;
    expect(applied).toBeDefined();
    expect(applied?.version).toBe(21);
  });

  it('backfills read_tokens = 0 when all text fields are null', () => {
    insertObservationWithoutReadTokens(db, {
      narrative: null,
      title: null,
      facts: null,
      concepts: null,
      text: null,
    });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(row.read_tokens).toBe(0);
  });

  it('backfills read_tokens using integer ceiling division of total length / 4', () => {
    // narrative: 'A'.repeat(12) = 12 chars → 3 tokens
    // title: 'B'.repeat(4) = 4 chars → 1 token
    // total: 16 chars → 4 tokens
    insertObservationWithoutReadTokens(db, {
      narrative: 'A'.repeat(12),
      title: 'B'.repeat(4),
      facts: null,
      concepts: null,
      text: null,
    });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(row.read_tokens).toBe(4);
  });

  it('backfills read_tokens summing all non-null fields', () => {
    // narrative: 8 chars, title: 4 chars, facts: 4 chars, concepts: 4 chars, text: 4 chars
    // total: 24 chars → 6 tokens
    insertObservationWithoutReadTokens(db, {
      narrative: '12345678',
      title: 'abcd',
      facts: 'wxyz',
      concepts: 'efgh',
      text: 'ijkl',
    });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(row.read_tokens).toBe(6);
  });

  it('backfills multiple rows correctly', () => {
    // Row 1: 4 chars narrative → 1 token
    insertObservationWithoutReadTokens(db, { narrative: 'abcd' });
    // Row 2: 8 chars text → 2 tokens
    insertObservationWithoutReadTokens(db, { text: '12345678' });
    // Row 3: all null → 0 tokens
    insertObservationWithoutReadTokens(db, {});

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const rows = db.prepare('SELECT id, read_tokens FROM observations ORDER BY id').all() as Array<{ id: number; read_tokens: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].read_tokens).toBe(1);
    expect(rows[1].read_tokens).toBe(2);
    expect(rows[2].read_tokens).toBe(0);
  });

  it('uses ceiling division for non-divisible lengths', () => {
    // narrative: 3 chars → ceil(3/4) = 1 token
    insertObservationWithoutReadTokens(db, { narrative: 'abc' });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(row.read_tokens).toBe(1);
  });

  it('is idempotent — running migrations twice does not change values or fail', () => {
    insertObservationWithoutReadTokens(db, { narrative: 'abcd' }); // 1 token

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const firstRun = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(firstRun.read_tokens).toBe(1);

    // Second run — should be no-op (migration already recorded)
    runner.runAllMigrations();

    const secondRun = db.prepare('SELECT read_tokens FROM observations WHERE id = 1').get() as { read_tokens: number };
    expect(secondRun.read_tokens).toBe(1);
  });
});
