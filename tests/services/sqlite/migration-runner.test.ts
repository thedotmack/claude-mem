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

interface IndexInfo {
  name: string;
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

function getIndexNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as IndexInfo[];
  return rows.map(r => r.name);
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
      expect(tables).toContain('projects');
      expect(tables).toContain('server_sessions');
      expect(tables).toContain('agent_events');
      expect(tables).toContain('memory_items');
      expect(tables).toContain('memory_sources');
      expect(tables).toContain('teams');
      expect(tables).toContain('team_members');
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
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
      expect(versions).toContain(4);   
      expect(versions).toContain(5);   
      expect(versions).toContain(6);   
      expect(versions).toContain(7);   
      expect(versions).toContain(8);   
      expect(versions).toContain(9);   
      expect(versions).toContain(10);  
      expect(versions).toContain(11);  
      expect(versions).toContain(16);  
      expect(versions).toContain(17);  
      expect(versions).toContain(20);  
      expect(versions).toContain(21);  
      expect(versions).toContain(22);  
      expect(versions).toContain(30);  
      expect(versions).toContain(33);
      expect(versions).toContain(34);
    });

    it('should create server-owned storage tables without changing legacy readability', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const now = new Date().toISOString();
      const epoch = Date.now();

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('content-readable', 'memory-readable', 'legacy-project', now, epoch, 'active');

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memory-readable', 'legacy-project', 'learned', 'Legacy observation', 'Still queryable', now, epoch);

      const observation = db.prepare('SELECT title, narrative FROM observations WHERE memory_session_id = ?').get('memory-readable') as { title: string; narrative: string };
      expect(observation.title).toBe('Legacy observation');
      expect(observation.narrative).toBe('Still queryable');

      const memoryItems = db.prepare('SELECT COUNT(*) as count FROM memory_items').get() as { count: number };
      expect(memoryItems.count).toBe(0);
    });

    it('should tighten legacy pending_messages status checks from old migration 28 databases', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      db.run(`
        CREATE TABLE sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
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
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          tool_use_id TEXT,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch INTEGER NOT NULL,
          completed_at_epoch INTEGER,
          worker_pid INTEGER
        )
      `);

      const now = new Date().toISOString();
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, now);
      const sessionId = Number(db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
        VALUES ('legacy-content', 'legacy-project', ?, ?)
      `).run(now, Date.now()).lastInsertRowid);
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'pending', ?)
      `).run(sessionId, Date.now());
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'failed', ?)
      `).run(sessionId, Date.now());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const pendingRows = db.prepare('SELECT COUNT(*) AS count FROM pending_messages').get() as { count: number };
      expect(pendingRows.count).toBe(1);
      const columns = getColumns(db, 'pending_messages').map(column => column.name);
      expect(columns).not.toContain('retry_count');
      expect(columns).not.toContain('completed_at_epoch');
      expect(columns).not.toContain('worker_pid');

      expect(() => db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'failed', ?)
      `).run(sessionId, Date.now())).toThrow();
    });
  });

  describe('idempotency — running migrations twice', () => {
    it('should succeed when run twice on the same database', () => {
      const runner = new MigrationRunner(db);

      runner.runAllMigrations();

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

  describe('schema drift recovery for migration 24', () => {
    it('should repair platform_source column and index even when version 24 is already recorded', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());

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
          status TEXT NOT NULL CHECK(status IN ('active','completed','failed'))
        )
      `);

      const runner = new MigrationRunner(db);
      expect(() => runner.runAllMigrations()).not.toThrow();

      const columnNames = getColumns(db, 'sdk_sessions').map(column => column.name);
      expect(columnNames).toContain('platform_source');

      const indexNames = getIndexNames(db, 'sdk_sessions');
      expect(indexNames).toContain('idx_sdk_sessions_platform_source');
    });
  });

  describe('issue #979 — old DatabaseManager version conflict', () => {
    it('should create core tables even when old migration versions 1-7 are in schema_versions', () => {
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

      const columns = getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('content_session_id');
    });
  });

  describe('crash recovery — leftover temp tables', () => {
    it('should handle leftover session_summaries_new table from crashed migration 7', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      db.prepare('DELETE FROM schema_versions WHERE version = 7').run();

      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('should handle leftover observations_new table from crashed migration 9', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      db.prepare('DELETE FROM schema_versions WHERE version = 9').run();

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
