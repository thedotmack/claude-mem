import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/services/sqlite/sqlite-compat.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { InjectionTracker } from '../../../src/services/sqlite/InjectionTracker.js';

/**
 * Row shape returned by context_injections queries
 */
interface InjectionRow {
  id: number;
  session_id: string | null;
  project: string;
  observation_ids: string;
  total_read_tokens: number;
  injection_source: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * TableColumnInfo for PRAGMA table_info
 */
interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Helper to create an in-memory SQLite DB and run all migrations
 */
function createTestDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();
  return db;
}

describe('InjectionTracker', () => {
  let db: Database;
  let tracker: InjectionTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new InjectionTracker(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('trackInjection — basic insert', () => {
    it('inserts a row into context_injections with all required fields', () => {
      tracker.trackInjection({
        sessionId: 'session-abc',
        project: '/home/user/myproject',
        observationIds: [1, 2, 3],
        totalReadTokens: 500,
        injectionSource: 'session_start',
      });

      const rows = db.prepare('SELECT * FROM context_injections').all() as InjectionRow[];
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.session_id).toBe('session-abc');
      expect(row.project).toBe('/home/user/myproject');
      expect(row.total_read_tokens).toBe(500);
      expect(row.injection_source).toBe('session_start');
    });

    it('stores observation_ids as a JSON array string', () => {
      tracker.trackInjection({
        sessionId: 'session-abc',
        project: '/home/user/project',
        observationIds: [10, 20, 30],
        totalReadTokens: 100,
        injectionSource: 'mcp_search',
      });

      const row = db.prepare('SELECT observation_ids FROM context_injections').get() as { observation_ids: string };
      expect(row.observation_ids).toBe('[10,20,30]');

      const parsed = JSON.parse(row.observation_ids) as number[];
      expect(parsed).toEqual([10, 20, 30]);
    });

    it('sets created_at as a valid ISO timestamp string', () => {
      const before = new Date().toISOString();
      tracker.trackInjection({
        project: '/project',
        observationIds: [1],
        totalReadTokens: 50,
        injectionSource: 'prompt_submit',
      });
      const after = new Date().toISOString();

      const row = db.prepare('SELECT created_at FROM context_injections').get() as { created_at: string };
      expect(row.created_at >= before).toBe(true);
      expect(row.created_at <= after).toBe(true);
    });

    it('sets created_at_epoch as a positive integer epoch', () => {
      const before = Date.now();
      tracker.trackInjection({
        project: '/project',
        observationIds: [],
        totalReadTokens: 0,
        injectionSource: 'session_start',
      });
      const after = Date.now();

      const row = db.prepare('SELECT created_at_epoch FROM context_injections').get() as { created_at_epoch: number };
      expect(row.created_at_epoch).toBeGreaterThanOrEqual(before);
      expect(row.created_at_epoch).toBeLessThanOrEqual(after);
    });
  });

  describe('trackInjection — sessionId is optional', () => {
    it('stores NULL for session_id when not provided', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [5],
        totalReadTokens: 200,
        injectionSource: 'mcp_search',
      });

      const row = db.prepare('SELECT session_id FROM context_injections').get() as { session_id: string | null };
      expect(row.session_id).toBeNull();
    });

    it('stores NULL for session_id when explicitly undefined', () => {
      tracker.trackInjection({
        sessionId: undefined,
        project: '/project',
        observationIds: [5],
        totalReadTokens: 200,
        injectionSource: 'prompt_submit',
      });

      const row = db.prepare('SELECT session_id FROM context_injections').get() as { session_id: string | null };
      expect(row.session_id).toBeNull();
    });
  });

  describe('trackInjection — empty observation_ids', () => {
    it('stores an empty JSON array when observationIds is empty', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [],
        totalReadTokens: 0,
        injectionSource: 'session_start',
      });

      const row = db.prepare('SELECT observation_ids FROM context_injections').get() as { observation_ids: string };
      expect(row.observation_ids).toBe('[]');
    });
  });

  describe('trackInjection — all injection_source values', () => {
    it('accepts session_start as injection_source', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [1],
        totalReadTokens: 100,
        injectionSource: 'session_start',
      });

      const row = db.prepare('SELECT injection_source FROM context_injections').get() as { injection_source: string };
      expect(row.injection_source).toBe('session_start');
    });

    it('accepts prompt_submit as injection_source', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [2],
        totalReadTokens: 200,
        injectionSource: 'prompt_submit',
      });

      const row = db.prepare('SELECT injection_source FROM context_injections').get() as { injection_source: string };
      expect(row.injection_source).toBe('prompt_submit');
    });

    it('accepts mcp_search as injection_source', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [3],
        totalReadTokens: 300,
        injectionSource: 'mcp_search',
      });

      const row = db.prepare('SELECT injection_source FROM context_injections').get() as { injection_source: string };
      expect(row.injection_source).toBe('mcp_search');
    });
  });

  describe('trackInjection — multiple rows', () => {
    it('inserts multiple independent rows', () => {
      tracker.trackInjection({
        sessionId: 'session-1',
        project: '/project',
        observationIds: [1, 2],
        totalReadTokens: 100,
        injectionSource: 'session_start',
      });

      tracker.trackInjection({
        sessionId: 'session-2',
        project: '/other-project',
        observationIds: [3, 4, 5],
        totalReadTokens: 300,
        injectionSource: 'mcp_search',
      });

      const rows = db.prepare('SELECT * FROM context_injections ORDER BY id ASC').all() as InjectionRow[];
      expect(rows).toHaveLength(2);

      expect(rows[0].session_id).toBe('session-1');
      expect(rows[0].project).toBe('/project');
      expect(rows[0].total_read_tokens).toBe(100);

      expect(rows[1].session_id).toBe('session-2');
      expect(rows[1].project).toBe('/other-project');
      expect(rows[1].total_read_tokens).toBe(300);
    });
  });

  describe('autoincrement id', () => {
    it('assigns incrementing integer IDs', () => {
      tracker.trackInjection({
        project: '/project',
        observationIds: [1],
        totalReadTokens: 10,
        injectionSource: 'session_start',
      });
      tracker.trackInjection({
        project: '/project',
        observationIds: [2],
        totalReadTokens: 20,
        injectionSource: 'prompt_submit',
      });

      const rows = db.prepare('SELECT id FROM context_injections ORDER BY id ASC').all() as { id: number }[];
      expect(rows[0].id).toBe(1);
      expect(rows[1].id).toBe(2);
    });
  });
});

describe('Migration 22 — context_injections table', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
  });

  afterEach(() => {
    db.close();
  });

  it('creates the context_injections table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_injections'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('context_injections');
  });

  it('context_injections table has expected columns', () => {
    const columns = db.prepare('PRAGMA table_info(context_injections)').all() as TableColumnInfo[];
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('session_id');
    expect(columnNames).toContain('project');
    expect(columnNames).toContain('observation_ids');
    expect(columnNames).toContain('total_read_tokens');
    expect(columnNames).toContain('injection_source');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('created_at_epoch');
  });

  it('project and observation_ids and injection_source columns are NOT NULL', () => {
    const columns = db.prepare('PRAGMA table_info(context_injections)').all() as TableColumnInfo[];
    const colMap = Object.fromEntries(columns.map(c => [c.name, c]));

    expect(colMap['project'].notnull).toBe(1);
    expect(colMap['observation_ids'].notnull).toBe(1);
    expect(colMap['injection_source'].notnull).toBe(1);
    expect(colMap['total_read_tokens'].notnull).toBe(1);
    expect(colMap['created_at'].notnull).toBe(1);
    expect(colMap['created_at_epoch'].notnull).toBe(1);
  });

  it('session_id column is nullable', () => {
    const columns = db.prepare('PRAGMA table_info(context_injections)').all() as TableColumnInfo[];
    const colMap = Object.fromEntries(columns.map(c => [c.name, c]));

    expect(colMap['session_id'].notnull).toBe(0);
  });

  it('creates the idx_context_injections_project index', () => {
    const indexes = db.prepare('PRAGMA index_list(context_injections)').all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_context_injections_project');
  });

  it('creates the idx_context_injections_created index', () => {
    const indexes = db.prepare('PRAGMA index_list(context_injections)').all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_context_injections_created');
  });

  it('creates the idx_context_injections_source index', () => {
    const indexes = db.prepare('PRAGMA index_list(context_injections)').all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_context_injections_source');
  });

  it('records migration 22 in schema_versions', () => {
    const version = db
      .prepare('SELECT version FROM schema_versions WHERE version = 22')
      .get() as { version: number } | undefined;
    expect(version).toBeDefined();
    expect(version?.version).toBe(22);
  });

  it('is idempotent — running migrations twice does not fail', () => {
    const runner = new MigrationRunner(db);
    expect(() => runner.runAllMigrations()).not.toThrow();
  });
});
