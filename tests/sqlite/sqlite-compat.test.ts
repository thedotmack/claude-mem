/**
 * SQLite Compatibility Layer Tests
 *
 * TDD tests for the sqlite-compat.ts wrapper around better-sqlite3.
 * Tests verify that the wrapper provides the expected Database API
 * for all patterns used in the codebase.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/services/sqlite/sqlite-compat.js';

describe('sqlite-compat', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('constructor', () => {
    it('creates an in-memory database', () => {
      // If we get here without error, construction succeeded
      expect(db).toBeDefined();
    });

    it('accepts create/readwrite options without error', () => {
      const db2 = new Database(':memory:', { create: true, readwrite: true });
      expect(db2).toBeDefined();
      db2.close();
    });
  });

  describe('db.run() - multi-statement exec', () => {
    it('executes single DDL statements', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const result = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'test') as Record<string, unknown> | undefined;
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).name).toBe('test');
    });

    it('executes multi-statement SQL', () => {
      db.run(`
        CREATE TABLE test1 (id INTEGER PRIMARY KEY);
        CREATE TABLE test2 (id INTEGER PRIMARY KEY);
      `);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Record<string, unknown>[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('test1');
      expect(tableNames).toContain('test2');
    });

    it('executes PRAGMA statements', () => {
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');
      const fk = db.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>;
      expect(fk.foreign_keys).toBe(1);
    });

    it('executes ALTER TABLE statements', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
      db.run('ALTER TABLE test ADD COLUMN name TEXT');
      const cols = db.query('PRAGMA table_info(test)').all() as Record<string, unknown>[];
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('name');
    });
  });

  describe('db.query() - prepare statement', () => {
    it('returns a statement that supports .all()', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      db.prepare('INSERT INTO test (name) VALUES (?)').run('alice');
      db.prepare('INSERT INTO test (name) VALUES (?)').run('bob');

      const rows = db.query('SELECT * FROM test ORDER BY id').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe('alice');
      expect(rows[1].name).toBe('bob');
    });

    it('returns a statement that supports .get()', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      db.prepare('INSERT INTO test (name) VALUES (?)').run('alice');

      const row = db.query('SELECT * FROM test WHERE name = ?').get('alice') as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row.name).toBe('alice');
    });

    it('returns a statement that supports .run()', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const result = db.query('INSERT INTO test (name) VALUES (?)').run('alice');
      expect(result.changes).toBe(1);
      expect(typeof result.lastInsertRowid).toBe('number');
    });
  });

  describe('db.prepare() - CRUD operations', () => {
    beforeEach(() => {
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, value INTEGER)');
    });

    it('INSERT returns lastInsertRowid', () => {
      const result = db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('a', 1);
      expect(result.lastInsertRowid).toBe(1);

      const result2 = db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('b', 2);
      expect(result2.lastInsertRowid).toBe(2);
    });

    it('UPDATE returns changes count', () => {
      db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('a', 1);
      db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('b', 2);

      const result = db.prepare('UPDATE items SET value = ? WHERE name = ?').run(99, 'a');
      expect(result.changes).toBe(1);
    });

    it('DELETE returns changes count', () => {
      db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('a', 1);
      db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('b', 2);

      const result = db.prepare('DELETE FROM items WHERE name = ?').run('a');
      expect(result.changes).toBe(1);
    });

    it('.get() returns undefined for no match', () => {
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(999);
      expect(row).toBeUndefined();
    });

    it('.all() returns empty array for no matches', () => {
      const rows = db.prepare('SELECT * FROM items WHERE value > ?').all(999);
      expect(rows).toEqual([]);
    });
  });

  describe('db.transaction()', () => {
    beforeEach(() => {
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
    });

    it('commits successful transactions', () => {
      const insertMany = db.transaction((names: string[]) => {
        for (const name of names) {
          db.prepare('INSERT INTO items (name) VALUES (?)').run(name);
        }
      });

      insertMany(['a', 'b', 'c']);

      const rows = db.prepare('SELECT * FROM items').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(3);
    });

    it('rolls back on error', () => {
      const insertBad = db.transaction(() => {
        db.prepare('INSERT INTO items (name) VALUES (?)').run('good');
        // This will fail because name is NOT NULL
        db.prepare('INSERT INTO items (name) VALUES (?)').run(null);
      });

      expect(() => { insertBad(); }).toThrow();

      const rows = db.prepare('SELECT * FROM items').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(0);
    });

    it('supports transaction functions with arguments', () => {
      const claimAndDelete = db.transaction((sessionId: number) => {
        db.prepare('INSERT INTO items (name) VALUES (?)').run(`session-${String(sessionId)}`);
        const item = db.prepare('SELECT * FROM items WHERE name = ?').get(`session-${String(sessionId)}`) as Record<string, unknown>;
        return item;
      });

      const result = claimAndDelete(42);
      expect(result.name).toBe('session-42');
    });
  });

  describe('PRAGMA introspection (used by migration runner)', () => {
    it('table_info returns column metadata', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL, value REAL)');
      const cols = db.query('PRAGMA table_info(test)').all() as Record<string, unknown>[];
      expect(cols).toHaveLength(3);
      const nameCol = cols.find((c) => c.name === 'name');
      const valueCol = cols.find((c) => c.name === 'value');
      expect(nameCol).toBeDefined();
      expect(valueCol).toBeDefined();
      expect((nameCol as Record<string, unknown>).notnull).toBe(1);
      expect((valueCol as Record<string, unknown>).notnull).toBe(0);
    });

    it('index_list returns index metadata', () => {
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
      const indexes = db.query('PRAGMA index_list(test)').all() as Record<string, unknown>[];
      expect(indexes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('FTS5 support (used by user_prompts migration)', () => {
    it('creates and queries FTS5 virtual tables', () => {
      db.run(`
        CREATE TABLE docs (id INTEGER PRIMARY KEY, content TEXT);
        CREATE VIRTUAL TABLE docs_fts USING fts5(content, content='docs', content_rowid='id');
      `);

      db.prepare('INSERT INTO docs (content) VALUES (?)').run('hello world');
      db.prepare('INSERT INTO docs_fts (rowid, content) VALUES (?, ?)').run(1, 'hello world');

      const results = db.prepare("SELECT * FROM docs_fts WHERE docs_fts MATCH 'hello'").all() as Record<string, unknown>[];
      expect(results).toHaveLength(1);
    });
  });
});
