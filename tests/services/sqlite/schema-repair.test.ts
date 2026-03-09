/**
 * Tests for malformed schema repair in Database.ts
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with temp file — tests actual schema repair logic
 * - Uses Python sqlite3 to simulate cross-version schema corruption
 *   (bun:sqlite doesn't allow writable_schema modifications)
 * - Covers the cross-machine sync scenario from issue #1307
 *
 * Value: Prevents the silent 503 failure loop when a DB is synced between
 * machines running different claude-mem versions
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, execSync } from 'child_process';

function tempDbPath(): string {
  return join(tmpdir(), `claude-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function hasPython(): boolean {
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Use Python's sqlite3 to corrupt a DB by removing the content_hash column
 * from the observations table definition while leaving the index intact.
 * This simulates what happens when a DB from a newer version is synced.
 */
function corruptDbViaPython(dbPath: string): void {
  const script = join(tmpdir(), `corrupt-${Date.now()}.py`);
  writeFileSync(script, `
import sqlite3, re, sys
c = sqlite3.connect(sys.argv[1])
c.execute("PRAGMA writable_schema = ON")
row = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").fetchone()
if row:
    new_sql = re.sub(r',\\s*content_hash\\s+TEXT', '', row[0])
    c.execute("UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='observations'", (new_sql,))
c.execute("PRAGMA writable_schema = OFF")
c.commit()
c.close()
`);
  try {
    execSync(`python3 "${script}" "${dbPath}"`, { timeout: 10000 });
  } finally {
    if (existsSync(script)) unlinkSync(script);
  }
}

describe('Schema repair on malformed database', () => {
  it('should repair a database with an orphaned index referencing a non-existent column', () => {
    if (!hasPython()) {
      console.log('Python3 not available, skipping test');
      return;
    }

    const dbPath = tempDbPath();
    try {
      // Step 1: Create a valid database with all migrations
      const db = new Database(dbPath, { create: true, readwrite: true });
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      // Verify content_hash column and index exist
      const hasContentHash = db.prepare('PRAGMA table_info(observations)').all()
        .some((col: any) => col.name === 'content_hash');
      expect(hasContentHash).toBe(true);

      // Checkpoint WAL so all data is in the main file
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();

      // Step 2: Corrupt the DB
      corruptDbViaPython(dbPath);

      // Step 3: Verify the DB is actually corrupted
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

      // Step 4: Open via ClaudeMemDatabase — it should auto-repair
      const repaired = new ClaudeMemDatabase(dbPath);

      // Verify the DB is functional
      const tables = repaired.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('sdk_sessions');

      // Verify the index was recreated by the migration runner
      const indexes = repaired.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_content_hash'")
        .all() as { name: string }[];
      expect(indexes.length).toBe(1);

      // Verify the content_hash column was re-added by the migration
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
    if (!hasPython()) {
      console.log('Python3 not available, skipping test');
      return;
    }

    const dbPath = tempDbPath();
    const scriptPath = join(tmpdir(), `corrupt-nosv-${Date.now()}.py`);
    try {
      // Build a minimal DB with only a malformed observations table and orphaned index
      // — no schema_versions table. This simulates a partially-initialized DB that was
      // synced before migrations ever ran.
      writeFileSync(scriptPath, `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute('PRAGMA writable_schema = ON')
# Inject an orphaned index into sqlite_master without any backing table.
# This simulates a partially-synced DB where index metadata arrived but
# the table schema is incomplete or missing columns.
idx_sql = 'CREATE INDEX idx_observations_content_hash ON observations(content_hash, created_at_epoch)'
c.execute(
  "INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('index', 'idx_observations_content_hash', 'observations', 0, ?)",
  (idx_sql,)
)
c.execute('PRAGMA writable_schema = OFF')
c.commit()
c.close()
`);
      execFileSync('python3', [scriptPath, dbPath], { timeout: 10000 });

      // Verify it's corrupted
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

      // ClaudeMemDatabase must repair and fully initialize despite missing schema_versions
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
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    }
  });

  it('should preserve existing data through repair and re-migration', () => {
    if (!hasPython()) {
      console.log('Python3 not available, skipping test');
      return;
    }

    const dbPath = tempDbPath();
    try {
      // Step 1: Create a fully migrated DB and insert a session + observation
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

      // Step 2: Corrupt the DB
      corruptDbViaPython(dbPath);

      // Step 3: Repair via ClaudeMemDatabase
      const repaired = new ClaudeMemDatabase(dbPath);

      // Data must survive the repair + re-migration
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
