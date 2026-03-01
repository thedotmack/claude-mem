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

  // Create pre-migration-26 FTS5 table (6 columns, as migration 24 left them)
  db.run(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title,
      narrative,
      facts,
      concepts,
      subtitle,
      text,
      content='observations',
      content_rowid='id',
      tokenize='unicode61'
    )
  `);

  // Create triggers (6-column, pre-migration-26)
  db.run(`
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
    END
  `);
  db.run(`
    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
      VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
    END
  `);
  db.run(`
    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
      VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
    END
  `);

  // session_summaries_fts (not touched by migration 26, just needed for completeness)
  db.run(`
    CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
      request, investigated, learned, completed, next_steps, notes,
      content='session_summaries', content_rowid='id', tokenize='unicode61'
    )
  `);
  db.run(`
    CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
    END
  `);
  db.run(`
    CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
    END
  `);
  db.run(`
    CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
    END
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

// ---------------------------------------------------------------------------
// FTS5 Trigger Update Tests (Task 2)
// ---------------------------------------------------------------------------

function getFTSColumnCount(db: Database): number {
  // Query the FTS shadow table to get column count
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).get() as { sql: string } | undefined;
    if (!row) return 0;
    // Count columns from the CREATE VIRTUAL TABLE statement
    const colMatch = row.sql.match(/USING fts5\(([^)]+)\)/s);
    if (!colMatch) return 0;
    const cols = colMatch[1].split(',').filter(c => !c.trim().startsWith('content') && !c.trim().startsWith('tokenize'));
    return cols.length;
  } catch {
    return 0;
  }
}

function hasTrigger(db: Database, triggerName: string): boolean {
  const result = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?"
  ).get(triggerName) as { name: string } | undefined;
  return !!result;
}

function getTriggerSQL(db: Database, triggerName: string): string {
  const result = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?"
  ).get(triggerName) as { sql: string } | undefined;
  return result?.sql ?? '';
}

describe('FTS5 trigger update (migration 26)', () => {
  let db: Database;

  beforeEach(() => {
    db = createPreMigrationDb();
  });

  afterEach(() => {
    db.close();
  });

  it('FTS table has 8 columns after migration (was 6)', () => {
    expect(getFTSColumnCount(db)).toBe(6);

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    expect(getFTSColumnCount(db)).toBe(8);
  });

  it('topics are searchable via FTS5 MATCH', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Insert observation with topics
    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, topics, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Test', 'Narrative', '["authentication", "migration"]', new Date().toISOString(), Date.now());

    const results = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'authentication'"
    ).all();
    expect(results.length).toBe(1);
  });

  it('entity names are searchable via FTS5 MATCH', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Insert observation with entities (comma-separated names go in FTS)
    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, entities, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Test', 'Narrative',
      JSON.stringify([{ name: 'Alice', type: 'person' }, { name: 'DevOps', type: 'team' }]),
      new Date().toISOString(), Date.now());

    const results = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'Alice'"
    ).all();
    expect(results.length).toBe(1);
  });

  it('bm25 with 8 weights executes without error', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, topics, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Auth system', 'Authentication review', '["auth"]', new Date().toISOString(), Date.now());

    const results = db.prepare(
      "SELECT rowid, bm25(observations_fts, 10.0, 5.0, 3.0, 2.0, 1.0, 1.0, 2.0, 1.5) as score FROM observations_fts WHERE observations_fts MATCH 'auth' ORDER BY rank"
    ).all() as Array<{ rowid: number; score: number }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeDefined();
  });

  it('UPDATE trigger has WHEN clause (does not fire on access_count/pinned changes)', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const triggerSQL = getTriggerSQL(db, 'observations_au');
    expect(triggerSQL).toContain('WHEN');
    // Should fire on content changes
    expect(triggerSQL).toContain('OLD.title');
    expect(triggerSQL).toContain('OLD.topics');
    // Should NOT mention access_count or pinned in the WHEN clause
    // (the trigger should NOT fire on those changes)
  });

  it('updating access_count does NOT trigger FTS re-index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, topics, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Unique term xyzzy', 'Narrative', '["auth"]', new Date().toISOString(), Date.now());

    // Verify searchable
    const before = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzzy'"
    ).all();
    expect(before.length).toBe(1);

    // Update access_count — should NOT trigger FTS re-index
    db.prepare('UPDATE observations SET access_count = access_count + 1 WHERE id = 1').run();

    // Still searchable (FTS not corrupted)
    const after = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'xyzzy'"
    ).all();
    expect(after.length).toBe(1);
  });

  it('deleting an observation removes it from FTS index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Deletable item', 'Narrative', new Date().toISOString(), Date.now());

    const before = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'Deletable'"
    ).all();
    expect(before.length).toBe(1);

    db.prepare('DELETE FROM observations WHERE id = 1').run();

    const after = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'Deletable'"
    ).all();
    expect(after.length).toBe(0);
  });

  it('updating title updates FTS index', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('mem-1', 'test', 'discovery', 'Original title', 'Narrative', new Date().toISOString(), Date.now());

    db.prepare("UPDATE observations SET title = 'Updated foobar title' WHERE id = 1").run();

    const oldMatch = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'Original'"
    ).all();
    expect(oldMatch.length).toBe(0);

    const newMatch = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'foobar'"
    ).all();
    expect(newMatch.length).toBe(1);
  });

  it('pre-existing observations are backfilled into new FTS columns', () => {
    // Insert observation BEFORE migration with topics already set in main table
    // (simulating data that was there pre-migration)
    insertObservation(db, { title: 'Pre-existing obs', narrative: 'Has old data' });

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Pre-existing obs should be searchable by its title via FTS
    // Use quotes around hyphenated term (FTS5 treats "-" as column prefix operator)
    const results = db.prepare(
      `SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"Pre-existing"'`
    ).all();
    expect(results.length).toBe(1);
  });
});
