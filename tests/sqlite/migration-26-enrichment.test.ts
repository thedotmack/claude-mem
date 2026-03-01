/**
 * Migration test: ensureEnrichmentColumns (migration 26)
 *
 * Tests that:
 * 1. All 6 columns are added to observations table if missing
 * 2. Default values are correct (NULL for text fields, 0 for numeric, NULL for supersedes_id)
 * 3. 3 partial indexes are created
 * 4. Migration is idempotent (safe to run twice)
 * 5. Version 26 is recorded in schema_versions
 *
 * RED phase: These tests should FAIL until ensureEnrichmentColumns() is added
 * to MigrationRunner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/services/sqlite/sqlite-compat.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import type { TableColumnInfo } from '../../src/types/database.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal in-memory database with all migrations up to (but not
 * including) migration 26, so we can test migration 26 in isolation.
 * Includes the priority column from migration 25.
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

  // observations table WITH priority (post-migration 25) but WITHOUT enrichment columns
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
      priority TEXT DEFAULT 'informational',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // sdk_sessions table
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

  // context_injections table
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

  // Mark all migrations up to 25 as already applied
  const versions = [4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 19, 20, 21, 23, 24, 25];
  const insertVersion = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  for (const v of versions) {
    insertVersion.run(v, new Date().toISOString());
  }

  return db;
}

function insertObservation(db: Database, overrides: Record<string, unknown> = {}): number {
  const defaults = {
    memory_session_id: 'mem-session-test',
    project: 'test-project',
    type: 'discovery',
    title: 'Test observation',
    narrative: 'Test narrative',
    priority: 'informational',
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
  };
  const values = { ...defaults, ...overrides };
  const cols = Object.keys(values);
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO observations (${cols.join(', ')}) VALUES (${placeholders})`
  );
  const result = stmt.run(...Object.values(values));
  return Number(result.lastInsertRowid);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const tableInfo = db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  return tableInfo.some(col => col.name === column);
}

function getColumnDefault(db: Database, table: string, column: string): string | null {
  const tableInfo = db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  const col = tableInfo.find(c => c.name === column);
  return col?.dflt_value ?? null;
}

function hasIndex(db: Database, indexName: string): boolean {
  const result = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get(indexName) as { name: string } | undefined;
  return !!result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ENRICHMENT_COLUMNS = [
  'topics',
  'entities',
  'event_date',
  'pinned',
  'access_count',
  'supersedes_id',
] as const;

describe('ensureEnrichmentColumns migration (version 26)', () => {
  let db: Database;

  beforeEach(() => {
    db = createPreMigrationDb();
  });

  afterEach(() => {
    db.close();
  });

  // -- Column existence --

  it('adds all 6 enrichment columns to observations table', () => {
    for (const col of ENRICHMENT_COLUMNS) {
      expect(hasColumn(db, 'observations', col)).toBe(false);
    }

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    for (const col of ENRICHMENT_COLUMNS) {
      expect(hasColumn(db, 'observations', col)).toBe(true);
    }
  });

  // -- Schema version --

  it('records version 26 in schema_versions', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const applied = db.prepare(
      'SELECT version FROM schema_versions WHERE version = ?'
    ).get(26) as { version: number } | undefined;
    expect(applied).toBeDefined();
    expect(applied?.version).toBe(26);
  });

  // -- Default values --

  it('sets NULL defaults for topics, entities, event_date, supersedes_id on existing rows', () => {
    insertObservation(db);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare(
      'SELECT topics, entities, event_date, supersedes_id FROM observations WHERE id = 1'
    ).get() as Record<string, unknown>;

    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
    expect(row.event_date).toBeNull();
    expect(row.supersedes_id).toBeNull();
  });

  it('sets 0 defaults for pinned and access_count on existing rows', () => {
    insertObservation(db);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare(
      'SELECT pinned, access_count FROM observations WHERE id = 1'
    ).get() as Record<string, unknown>;

    expect(row.pinned).toBe(0);
    expect(row.access_count).toBe(0);
  });

  it('sets correct column defaults in schema', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // SQLite PRAGMA table_info returns "NULL" string for DEFAULT NULL columns
    expect(getColumnDefault(db, 'observations', 'topics')).toBe('NULL');
    expect(getColumnDefault(db, 'observations', 'entities')).toBe('NULL');
    expect(getColumnDefault(db, 'observations', 'event_date')).toBe('NULL');
    expect(getColumnDefault(db, 'observations', 'pinned')).toBe('0');
    expect(getColumnDefault(db, 'observations', 'access_count')).toBe('0');
    expect(getColumnDefault(db, 'observations', 'supersedes_id')).toBe('NULL');
  });

  // -- Indexes --

  it('creates idx_observations_event_date partial index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(hasIndex(db, 'idx_observations_event_date')).toBe(true);
  });

  it('creates idx_observations_pinned partial index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(hasIndex(db, 'idx_observations_pinned')).toBe(true);
  });

  it('creates idx_observations_supersedes partial index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(hasIndex(db, 'idx_observations_supersedes')).toBe(true);
  });

  // -- Idempotency --

  it('is idempotent — running migrations twice does not fail', () => {
    insertObservation(db);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Verify first run
    for (const col of ENRICHMENT_COLUMNS) {
      expect(hasColumn(db, 'observations', col)).toBe(true);
    }

    // Second run — should be a no-op
    expect(() => runner.runAllMigrations()).not.toThrow();

    // Verify data intact
    const row = db.prepare(
      'SELECT topics, pinned, access_count FROM observations WHERE id = 1'
    ).get() as Record<string, unknown>;
    expect(row.topics).toBeNull();
    expect(row.pinned).toBe(0);
    expect(row.access_count).toBe(0);
  });

  // -- New insertions --

  it('allows new insertions without enrichment fields (NULL/0 defaults)', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Insert without specifying any enrichment columns
    const id = insertObservation(db, { title: 'New observation after migration' });

    const row = db.prepare(
      'SELECT topics, entities, event_date, pinned, access_count, supersedes_id FROM observations WHERE id = ?'
    ).get(id) as Record<string, unknown>;

    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
    expect(row.event_date).toBeNull();
    expect(row.pinned).toBe(0);
    expect(row.access_count).toBe(0);
    expect(row.supersedes_id).toBeNull();
  });

  it('allows new insertions with enrichment fields', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const topics = JSON.stringify(['auth', 'migration']);
    const entities = JSON.stringify([{ name: 'Alice', type: 'person' }]);
    const id = insertObservation(db, {
      title: 'Enriched observation',
      topics,
      entities,
      event_date: '2026-03-15',
      pinned: 1,
      access_count: 5,
      supersedes_id: 'abc-123',
    });

    const row = db.prepare(
      'SELECT topics, entities, event_date, pinned, access_count, supersedes_id FROM observations WHERE id = ?'
    ).get(id) as Record<string, unknown>;

    expect(row.topics).toBe(topics);
    expect(row.entities).toBe(entities);
    expect(row.event_date).toBe('2026-03-15');
    expect(row.pinned).toBe(1);
    expect(row.access_count).toBe(5);
    expect(row.supersedes_id).toBe('abc-123');
  });

  // -- Preserves existing data --

  it('preserves existing observation data after migration', () => {
    insertObservation(db, {
      title: 'Important discovery',
      narrative: 'Found a critical bug',
      priority: 'critical',
    });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const row = db.prepare(
      'SELECT title, narrative, priority FROM observations WHERE id = 1'
    ).get() as Record<string, unknown>;

    expect(row.title).toBe('Important discovery');
    expect(row.narrative).toBe('Found a critical bug');
    expect(row.priority).toBe('critical');
  });
});
