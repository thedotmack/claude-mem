import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

function tempDbPath(): string {
  return join(tmpdir(), `claude-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

// repairMalformedDatabase() shells out to `sqlite3 <db> .recover`, which depends
// on the dbpage virtual table. Some sqlite3 CLI builds (e.g. on the ubuntu CI
// runner) are compiled without it and fail with "no such table: sqlite_dbpage".
// The repair feature legitimately requires that capability, so we skip the repair
// tests when the host sqlite3 cannot perform .recover rather than reporting a
// false failure.
function canRecoverViaSqlite3(): boolean {
  const probe = tempDbPath();
  try {
    const db = new Database(probe, { create: true, readwrite: true });
    db.run('CREATE TABLE probe(x)');
    db.run('INSERT INTO probe(x) VALUES (1)');
    db.close();
    execFileSync('sqlite3', [probe, '.recover'], { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  } finally {
    cleanup(probe);
  }
}

const REPAIR_SUPPORTED = canRecoverViaSqlite3();

function skipUnlessRepairable(): boolean {
  if (!REPAIR_SUPPORTED) {
    console.log("sqlite3 CLI lacks .recover (no sqlite_dbpage), skipping repair test");
    return true;
  }
  return false;
}

function corruptDbViaSqlite3(dbPath: string): void {
  const script = join(tmpdir(), `corrupt-${Date.now()}.sql`);
  writeFileSync(script, `
PRAGMA writable_schema = ON;
UPDATE sqlite_master SET sql = replace(sql, ', content_hash TEXT', '')
  WHERE type = 'table' AND name = 'observations';
PRAGMA writable_schema = OFF;
`);
  try {
    execFileSync('sqlite3', [dbPath], { input: `.read ${script}\n`, timeout: 10000 });
  } finally {
    if (existsSync(script)) unlinkSync(script);
  }
}

function corruptDbNoSchemaVersion(dbPath: string): void {
  const script = join(tmpdir(), `corrupt-nosv-${Date.now()}.sql`);
  writeFileSync(script, `
PRAGMA writable_schema = ON;
INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql)
VALUES (
  'index',
  'idx_observations_content_hash',
  'observations',
  0,
  'CREATE INDEX idx_observations_content_hash ON observations(content_hash, created_at_epoch)'
);
PRAGMA writable_schema = OFF;
`);
  try {
    execFileSync('sqlite3', [dbPath], { input: `.read ${script}\n`, timeout: 10000 });
  } finally {
    if (existsSync(script)) unlinkSync(script);
  }
}

describe('Schema repair on malformed database', () => {
  it('should repair a database with an orphaned index referencing a non-existent column', () => {
    if (skipUnlessRepairable()) {
      return;
    }

    const dbPath = tempDbPath();
    try {
      const db = new Database(dbPath, { create: true, readwrite: true });
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const hasContentHash = db.prepare('PRAGMA table_info(observations)').all()
        .some((col: any) => col.name === 'content_hash');
      expect(hasContentHash).toBe(true);

      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();

      corruptDbViaSqlite3(dbPath);

      const corruptDb = new Database(dbPath, { readwrite: true });
      let threw = false;
      try {
        corruptDb.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
      } catch (e: any) {
        threw = true;
        expect(e.message).toContain('malformed database schema');
        expect(e.message).toContain('idx_observations_content_hash');
      }
      corruptDb.close();
      expect(threw).toBe(true);

      const repaired = new ClaudeMemDatabase(dbPath);

      const tables = repaired.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('sdk_sessions');

      const indexes = repaired.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_content_hash'")
        .all() as { name: string }[];
      expect(indexes.length).toBe(1);

      const columns = repaired.db.prepare('PRAGMA table_info(observations)').all() as { name: string }[];
      expect(columns.some(c => c.name === 'content_hash')).toBe(true);

      repaired.close();
    } finally {
      cleanup(dbPath);
    }
  });

  it('should handle a fresh database without triggering repair', () => {
    const dbPath = tempDbPath();
    try {
      const db = new ClaudeMemDatabase(dbPath);
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.length).toBeGreaterThan(0);
      db.close();
    } finally {
      cleanup(dbPath);
    }
  });

  it('should repair a corrupted DB that has no schema_versions table', () => {
    if (skipUnlessRepairable()) {
      return;
    }

    const dbPath = tempDbPath();
    try {
      corruptDbNoSchemaVersion(dbPath);

      const corruptDb = new Database(dbPath, { readwrite: true });
      let threw = false;
      try {
        corruptDb.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
      } catch (e: any) {
        threw = true;
        expect(e.message).toContain('malformed database schema');
      }
      corruptDb.close();
      expect(threw).toBe(true);

      const repaired = new ClaudeMemDatabase(dbPath);
      const tables = repaired.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('schema_versions');
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('sdk_sessions');
      repaired.close();
    } finally {
      cleanup(dbPath);
    }
  });

  it('should preserve existing data through repair and re-migration', () => {
    if (skipUnlessRepairable()) {
      return;
    }

    const dbPath = tempDbPath();
    try {
      const db = new Database(dbPath, { create: true, readwrite: true });
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const now = new Date().toISOString();
      const epoch = Date.now();
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-content-1', 'test-memory-1', 'test-project', now, epoch, 'active');

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-memory-1', 'test-project', 'discovery', now, epoch);

      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();

      corruptDbViaSqlite3(dbPath);

      const repaired = new ClaudeMemDatabase(dbPath);

      const sessions = repaired.db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const observations = repaired.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      expect(sessions.count).toBe(1);
      expect(observations.count).toBe(1);

      repaired.close();
    } finally {
      cleanup(dbPath);
    }
  });
});
