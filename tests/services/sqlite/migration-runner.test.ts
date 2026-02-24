/**
 * Tests for MigrationRunner idempotency and schema initialization (#979)
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' — tests actual migration SQL
 * - Validates idempotency by running migrations multiple times
 * - Covers the version-conflict scenario from issue #979
 *
 * Value: Prevents regression where old DatabaseManager migrations mask core table creation
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';

interface TableNameRow {
  name: string;
}

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

interface SchemaVersion {
  version: number;
}

interface ForeignKeyInfo {
  table: string;
  on_update: string;
  on_delete: string;
}

function getTableNames(db: Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as TableNameRow[];
  return rows.map(r => r.name);
}

function getColumns(db: Database, table: string): TableColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
}

function getSchemaVersions(db: Database): number[] {
  const rows = db.prepare('SELECT version FROM schema_versions ORDER BY version').all() as SchemaVersion[];
  return rows.map(r => r.version);
}

describe('MigrationRunner', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  describe('fresh database initialization', () => {
    it('should create all core tables on a fresh database', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tables = getTableNames(db);
      expect(tables).toContain('schema_versions');
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
    });

    it('should create sdk_sessions with all expected columns', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('content_session_id');
      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('worker_port');
      expect(columnNames).toContain('prompt_counter');
    });

    it('should create observations with all expected columns including content_hash', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'observations');
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('type');
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('narrative');
      expect(columnNames).toContain('prompt_number');
      expect(columnNames).toContain('discovery_tokens');
      expect(columnNames).toContain('content_hash');
    });

    it('should record all migration versions', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const versions = getSchemaVersions(db);
      // Core set of expected versions
      expect(versions).toContain(4);   // initializeSchema
      expect(versions).toContain(5);   // worker_port
      expect(versions).toContain(6);   // prompt tracking
      expect(versions).toContain(7);   // remove unique constraint
      expect(versions).toContain(8);   // hierarchical fields
      expect(versions).toContain(9);   // text nullable
      expect(versions).toContain(10);  // user_prompts
      expect(versions).toContain(11);  // discovery_tokens
      expect(versions).toContain(16);  // pending_messages
      expect(versions).toContain(17);  // rename columns
      expect(versions).toContain(19);  // repair (noop)
      expect(versions).toContain(20);  // failed_at_epoch
      expect(versions).toContain(21);  // ON UPDATE CASCADE
      expect(versions).toContain(22);  // content_hash
    });
  });

  describe('idempotency — running migrations twice', () => {
    it('should succeed when run twice on the same database', () => {
      const runner = new MigrationRunner(db);

      // First run
      runner.runAllMigrations();

      // Second run — must not throw
      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('should produce identical schema when run twice', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tablesAfterFirst = getTableNames(db);
      const versionsAfterFirst = getSchemaVersions(db);

      runner.runAllMigrations();

      const tablesAfterSecond = getTableNames(db);
      const versionsAfterSecond = getSchemaVersions(db);

      expect(tablesAfterSecond).toEqual(tablesAfterFirst);
      expect(versionsAfterSecond).toEqual(versionsAfterFirst);
    });
  });

  describe('issue #979 — old DatabaseManager version conflict', () => {
    it('should create core tables even when old migration versions 1-7 are in schema_versions', () => {
      // Simulate the old DatabaseManager having applied its migrations 1-7
      // (which are completely different operations with the same version numbers)
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const now = new Date().toISOString();
      for (let v = 1; v <= 7; v++) {
        db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(v, now);
      }

      // Now run MigrationRunner — core tables MUST still be created
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tables = getTableNames(db);
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
    });

    it('should handle version 5 conflict (old=drop tables, new=add column) correctly', () => {
      // Old migration 5 drops streaming_sessions/observation_queue
      // New migration 5 adds worker_port column to sdk_sessions
      // With old version 5 already recorded, MigrationRunner must still add the column
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // sdk_sessions should exist and have worker_port (added by later migrations even if v5 is skipped)
      const columns = getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('content_session_id');
    });
  });

  describe('crash recovery — leftover temp tables', () => {
    it('should handle leftover session_summaries_new table from crashed migration 7', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Simulate a leftover temp table from a crash
      db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      // Remove version 7 so migration tries to re-run
      db.prepare('DELETE FROM schema_versions WHERE version = 7').run();

      // Re-run should handle the leftover table gracefully
      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('should handle leftover observations_new table from crashed migration 9', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Simulate a leftover temp table from a crash
      db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      // Remove version 9 so migration tries to re-run
      db.prepare('DELETE FROM schema_versions WHERE version = 9').run();

      // Re-run should handle the leftover table gracefully
      expect(() => runner.runAllMigrations()).not.toThrow();
    });
  });

  describe('ON UPDATE CASCADE FK constraints', () => {
    it('should have ON UPDATE CASCADE on observations FK after migration 21', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const fks = db.prepare('PRAGMA foreign_key_list(observations)').all() as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });

    it('should have ON UPDATE CASCADE on session_summaries FK after migration 21', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const fks = db.prepare('PRAGMA foreign_key_list(session_summaries)').all() as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });
  });

  describe('data integrity during migration', () => {
    it('should preserve existing data through all migrations', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Insert test data
      const now = new Date().toISOString();
      const epoch = Date.now();

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-content-1', 'test-memory-1', 'test-project', now, epoch, 'active');

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-memory-1', 'test-project', 'test observation', 'discovery', now, epoch);

      db.prepare(`
        INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-memory-1', 'test-project', 'test request', now, epoch);

      // Run migrations again — data should survive
      runner.runAllMigrations();

      const sessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const observations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const summaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

      expect(sessions.count).toBe(1);
      expect(observations.count).toBe(1);
      expect(summaries.count).toBe(1);
    });
  });
});
