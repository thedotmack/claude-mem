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
import { createClient } from '@libsql/client';
import { LibsqlAdapter } from '../../../src/services/sqlite/adapters/libsql-adapter.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import type { DbAdapter } from '../../../src/services/sqlite/adapter.js';

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

async function getTableNames(db: DbAdapter): Promise<string[]> {
  const result = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return (result.rows as TableNameRow[]).map(r => r.name);
}

async function getColumns(db: DbAdapter, table: string): Promise<TableColumnInfo[]> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return result.rows as TableColumnInfo[];
}

async function getSchemaVersions(db: DbAdapter): Promise<number[]> {
  const result = await db.execute('SELECT version FROM schema_versions ORDER BY version');
  return (result.rows as SchemaVersion[]).map(r => r.version);
}

describe('MigrationRunner', () => {
  let db: DbAdapter;

  beforeEach(async () => {
    const client = createClient({ url: 'file::memory:' });
    db = new LibsqlAdapter(client);
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA foreign_keys = ON');
  });

  afterEach(async () => {
    await db.close();
  });

  describe('fresh database initialization', () => {
    it('should create all core tables on a fresh database', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const tables = await getTableNames(db);
      expect(tables).toContain('schema_versions');
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
    });

    it('should create sdk_sessions with all expected columns', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const columns = await getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('content_session_id');
      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('worker_port');
      expect(columnNames).toContain('prompt_counter');
    });

    it('should create observations with all expected columns including content_hash', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const columns = await getColumns(db, 'observations');
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

    it('should record all migration versions', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const versions = await getSchemaVersions(db);
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
    it('should succeed when run twice on the same database', async () => {
      const runner = new MigrationRunner(db);

      // First run
      await runner.runAllMigrations();

      // Second run — must not throw
      await runner.runAllMigrations();
    });

    it('should produce identical schema when run twice', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const tablesAfterFirst = await getTableNames(db);
      const versionsAfterFirst = await getSchemaVersions(db);

      await runner.runAllMigrations();

      const tablesAfterSecond = await getTableNames(db);
      const versionsAfterSecond = await getSchemaVersions(db);

      expect(tablesAfterSecond).toEqual(tablesAfterFirst);
      expect(versionsAfterSecond).toEqual(versionsAfterFirst);
    });
  });

  describe('issue #979 — old DatabaseManager version conflict', () => {
    it('should create core tables even when old migration versions 1-7 are in schema_versions', async () => {
      // Simulate the old DatabaseManager having applied its migrations 1-7
      // (which are completely different operations with the same version numbers)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const now = new Date().toISOString();
      for (let v = 1; v <= 7; v++) {
        await db.execute('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)', [v, now]);
      }

      // Now run MigrationRunner — core tables MUST still be created
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const tables = await getTableNames(db);
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
    });

    it('should handle version 5 conflict (old=drop tables, new=add column) correctly', async () => {
      // Old migration 5 drops streaming_sessions/observation_queue
      // New migration 5 adds worker_port column to sdk_sessions
      // With old version 5 already recorded, MigrationRunner must still add the column
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      await db.execute('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)', [5, new Date().toISOString()]);

      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      // sdk_sessions should exist and have worker_port (added by later migrations even if v5 is skipped)
      const columns = await getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('content_session_id');
      expect(columnNames).toContain('worker_port');
    });
  });

  describe('crash recovery — leftover temp tables', () => {
    it('should handle leftover session_summaries_new table from crashed migration 7', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      // Simulate a leftover temp table from a crash
      await db.execute(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      // Remove version 7 so migration tries to re-run
      await db.execute('DELETE FROM schema_versions WHERE version = 7');

      // Re-run should handle the leftover table gracefully
      await runner.runAllMigrations();
    });

    it('should handle leftover observations_new table from crashed migration 9', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      // Simulate a leftover temp table from a crash
      await db.execute(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      // Remove version 9 so migration tries to re-run
      await db.execute('DELETE FROM schema_versions WHERE version = 9');

      // Re-run should handle the leftover table gracefully
      await runner.runAllMigrations();
    });
  });

  describe('ON UPDATE CASCADE FK constraints', () => {
    it('should have ON UPDATE CASCADE on observations FK after migration 21', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const result = await db.execute('PRAGMA foreign_key_list(observations)');
      const fks = result.rows as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });

    it('should have ON UPDATE CASCADE on session_summaries FK after migration 21', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const result = await db.execute('PRAGMA foreign_key_list(session_summaries)');
      const fks = result.rows as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });
  });

  describe('data integrity during migration', () => {
    it('should preserve existing data through all migrations', async () => {
      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      // Insert test data
      const now = new Date().toISOString();
      const epoch = Date.now();

      await db.execute(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ['test-content-1', 'test-memory-1', 'test-project', now, epoch, 'active']);

      await db.execute(`
        INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ['test-memory-1', 'test-project', 'test observation', 'discovery', now, epoch]);

      await db.execute(`
        INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `, ['test-memory-1', 'test-project', 'test request', now, epoch]);

      // Run migrations again — data should survive
      await runner.runAllMigrations();

      const sessions = await db.execute('SELECT COUNT(*) as count FROM sdk_sessions');
      const observations = await db.execute('SELECT COUNT(*) as count FROM observations');
      const summaries = await db.execute('SELECT COUNT(*) as count FROM session_summaries');

      expect((sessions.rows[0] as { count: number }).count).toBe(1);
      expect((observations.rows[0] as { count: number }).count).toBe(1);
      expect((summaries.rows[0] as { count: number }).count).toBe(1);
    });
  });
});
