/**
 * Migration test: recreateFTSTablesWithUnicode61 (migration 24)
 *
 * Tests that:
 * 1. Migration runs on fresh database — FTS5 tables created with unicode61 tokenizer
 * 2. Migration is idempotent — running twice does not error (version 24 check)
 * 3. Repopulation works — existing observations are indexed in FTS5 after migration
 * 4. Triggers work — INSERT a new observation appears in FTS5
 * 5. bm25() function works — bm25() query returns scores
 * 6. Column order correct — title, narrative, facts, concepts, subtitle, text for observations_fts
 * 7. session_summaries_fts also recreated with unicode61 tokenizer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/services/sqlite/sqlite-compat.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FtsTableInfo {
  name: string;
}

interface FtsSearchResult {
  rowid: number;
  rank?: number;
}

interface ObservationsRow {
  id: number;
  title: string | null;
  narrative: string | null;
}

interface SchemaVersion {
  version: number;
}

/**
 * Build a full in-memory database with all migrations up to and including
 * migration 23, so we can test migration 24 in isolation via MigrationRunner.
 *
 * This mirrors the approach used in migration-read-tokens.test.ts.
 */
function createPreMigration24Db(): Database {
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
      failed_at_epoch INTEGER,
      subprocess_pid INTEGER
    )
  `);

  // observations table with all columns (post migration 8, 9, 21)
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

  // session_summaries table with all columns
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

  // user_prompts_fts (already exists pre-24)
  db.run(`
    CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
      prompt_text,
      content='user_prompts',
      content_rowid='id'
    )
  `);

  // context_injections table
  db.run(`
    CREATE TABLE context_injections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project TEXT NOT NULL,
      observation_ids TEXT NOT NULL,
      total_read_tokens INTEGER NOT NULL,
      injection_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // Pre-migration-24 FTS5 tables with OLD column order (no unicode61)
  db.run(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title,
      subtitle,
      narrative,
      text,
      facts,
      concepts,
      content='observations',
      content_rowid='id'
    )
  `);

  db.run(`
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END
  `);

  db.run(`
    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    END
  `);

  db.run(`
    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END
  `);

  db.run(`
    CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
      request,
      investigated,
      learned,
      completed,
      next_steps,
      notes,
      content='session_summaries',
      content_rowid='id'
    )
  `);

  db.run(`
    CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
    END
  `);

  db.run(`
    CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    END
  `);

  db.run(`
    CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
    END
  `);

  // Mark all migrations 4 through 23 as already applied
  const allVersions = [4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 19, 20, 21, 22, 23];
  const insertVersion = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  for (const v of allVersions) {
    insertVersion.run(v, new Date().toISOString());
  }

  return db;
}

/**
 * Insert a test observation row and return its rowid.
 */
function insertTestObservation(
  db: Database,
  opts: {
    title?: string;
    narrative?: string;
    facts?: string;
    concepts?: string;
    subtitle?: string;
    text?: string;
  } = {}
): number {
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, facts, concepts, subtitle, text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    'test-mem-session',
    'test-project',
    'discovery',
    opts.title ?? null,
    opts.narrative ?? null,
    opts.facts ?? null,
    opts.concepts ?? null,
    opts.subtitle ?? null,
    opts.text ?? null,
    new Date().toISOString(),
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Check if a trigger exists in the database.
 */
function triggerExists(db: Database, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?"
  ).get(name) as FtsTableInfo | undefined;
  return row !== undefined;
}

/**
 * Get the FTS5 table config string for a virtual table.
 * Returns the sql from sqlite_master.
 */
function getFtsTableSql(db: Database, tableName: string): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName) as { sql: string } | undefined;
  return row?.sql ?? '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recreateFTSTablesWithUnicode61 migration (version 24)', () => {
  describe('via MigrationRunner', () => {
    let db: Database;

    beforeEach(() => {
      db = createPreMigration24Db();
    });

    afterEach(() => {
      db.close();
    });

    it('creates observations_fts with unicode61 tokenizer after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const sql = getFtsTableSql(db, 'observations_fts');
      expect(sql).toContain('unicode61');
    });

    it('creates session_summaries_fts with unicode61 tokenizer after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const sql = getFtsTableSql(db, 'session_summaries_fts');
      expect(sql).toContain('unicode61');
    });

    it('records version 24 in schema_versions', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const applied = db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;
      expect(applied).toBeDefined();
      expect(applied?.version).toBe(24);
    });

    it('is idempotent — running migrations twice does not throw', () => {
      const runner = new MigrationRunner(db);

      expect(() => runner.runAllMigrations()).not.toThrow();
      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('idempotent — version 24 recorded exactly once', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();
      runner.runAllMigrations();

      const rows = db.prepare('SELECT version FROM schema_versions WHERE version = 24').all() as SchemaVersion[];
      expect(rows).toHaveLength(1);
    });

    it('repopulates existing observations into FTS5 after migration', () => {
      // Insert observations BEFORE running migration
      insertTestObservation(db, { title: 'FTS repopulation test', narrative: 'unicode61 tokenizer repopulation' });
      insertTestObservation(db, { narrative: 'Another observation to repopulate' });

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Search FTS5 for the first observation
      const results = db.prepare(
        "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'repopulation'"
      ).all() as FtsSearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('triggers work — new observation after migration appears in FTS5', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Insert AFTER migration so the new trigger fires
      const rowid = insertTestObservation(db, {
        title: 'Post-migration insert',
        narrative: 'triggercheck unique phrase',
      });

      const results = db.prepare(
        "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'triggercheck'"
      ).all() as FtsSearchResult[];

      expect(results).toHaveLength(1);
      expect(results[0].rowid).toBe(rowid);
    });

    it('bm25() scoring function works on observations_fts after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      insertTestObservation(db, {
        title: 'bm25 scoring test',
        narrative: 'semantic search with weighted scoring',
      });
      insertTestObservation(db, {
        narrative: 'another document for bm25 baseline comparison',
      });

      // bm25() should return numeric scores without error
      const results = db.prepare(
        "SELECT rowid, bm25(observations_fts, 10.0, 5.0, 3.0, 2.0, 1.0, 1.0) as score FROM observations_fts WHERE observations_fts MATCH 'scoring' ORDER BY rank"
      ).all() as Array<{ rowid: number; score: number }>;

      expect(results.length).toBeGreaterThanOrEqual(1);
      // bm25 returns negative values (more negative = better match in SQLite FTS5)
      expect(typeof results[0].score).toBe('number');
    });

    it('observations_fts column order is: title, narrative, facts, concepts, subtitle, text', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const sql = getFtsTableSql(db, 'observations_fts');
      // Verify the new BM25-optimised order: title first, subtitle near end
      const titlePos = sql.indexOf('title');
      const narrativePos = sql.indexOf('narrative');
      const factsPos = sql.indexOf('facts');
      const conceptsPos = sql.indexOf('concepts');
      const subtitlePos = sql.indexOf('subtitle');
      const textPos = sql.indexOf('text');

      expect(titlePos).toBeLessThan(narrativePos);
      expect(narrativePos).toBeLessThan(factsPos);
      expect(factsPos).toBeLessThan(conceptsPos);
      expect(conceptsPos).toBeLessThan(subtitlePos);
      expect(subtitlePos).toBeLessThan(textPos);
    });

    it('recreates observations_ai trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'observations_ai')).toBe(true);
    });

    it('recreates observations_ad trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'observations_ad')).toBe(true);
    });

    it('recreates observations_au trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'observations_au')).toBe(true);
    });

    it('recreates session_summaries_ai trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'session_summaries_ai')).toBe(true);
    });

    it('recreates session_summaries_ad trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'session_summaries_ad')).toBe(true);
    });

    it('recreates session_summaries_au trigger after migration', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(triggerExists(db, 'session_summaries_au')).toBe(true);
    });
  });

  describe('via SessionStore (constructor chain)', () => {
    let store: SessionStore;

    beforeEach(() => {
      store = new SessionStore(':memory:');
      // Insert an sdk_sessions row so FK constraints are satisfied when inserting observations
      store.db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('test-content-session', 'test-mem-session', 'test-project', ?, ?, 'active')
      `).run(new Date().toISOString(), Date.now());
    });

    afterEach(() => {
      store.db.close();
    });

    it('observations_fts exists with unicode61 tokenizer on fresh database', () => {
      const sql = getFtsTableSql(store.db, 'observations_fts');
      expect(sql).toContain('unicode61');
    });

    it('session_summaries_fts exists with unicode61 tokenizer on fresh database', () => {
      const sql = getFtsTableSql(store.db, 'session_summaries_fts');
      expect(sql).toContain('unicode61');
    });

    it('version 24 recorded in schema_versions after SessionStore construction', () => {
      const applied = store.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;
      expect(applied).toBeDefined();
      expect(applied?.version).toBe(24);
    });

    it('observations_fts column order starts with title then narrative', () => {
      const sql = getFtsTableSql(store.db, 'observations_fts');
      const titlePos = sql.indexOf('title');
      const narrativePos = sql.indexOf('narrative');
      expect(titlePos).toBeLessThan(narrativePos);
    });

    it('insert trigger fires correctly — FTS5 search works after observation insert', () => {
      const rowid = insertTestObservation(store.db, {
        title: 'SessionStore trigger test',
        narrative: 'uniquephrase for sessionstore fts verification',
      });

      const results = store.db.prepare(
        "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'uniquephrase'"
      ).all() as FtsSearchResult[];

      expect(results).toHaveLength(1);
      expect(results[0].rowid).toBe(rowid);
    });
  });
});
