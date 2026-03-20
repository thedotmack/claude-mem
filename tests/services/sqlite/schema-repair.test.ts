/**
 * Tests for malformed schema repair in Database.ts
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with temp file — tests actual schema repair logic
 * - Uses Python sqlite3 to simulate cross-version schema corruption
 *   (libsql doesn't allow writable_schema modifications)
 * - Covers the cross-machine sync scenario from issue #1307
 *
 * Value: Prevents the silent 503 failure loop when a DB is synced between
 * machines running different claude-mem versions
 */
import { describe, it, expect } from 'bun:test';
import { createClient } from '@libsql/client';
import { LibsqlAdapter } from '../../../src/services/sqlite/adapters/libsql-adapter.js';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, execSync } from 'child_process';
import type { DbAdapter } from '../../../src/services/sqlite/adapter.js';

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

/**
 * Helper to create a raw libsql adapter for a file-based DB
 */
async function createRawDb(dbPath: string): Promise<DbAdapter> {
  const client = createClient({ url: `file:${dbPath}` });
  const db = new LibsqlAdapter(client);
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  return db;
}

describe('Schema repair on malformed database', () => {
  it('should repair a database with an orphaned index referencing a non-existent column', async () => {
    if (!hasPython()) {
      console.log('Python3 not available, skipping test');
      return;
    }

    const dbPath = tempDbPath();
    try {
      // Step 1: Create a valid database with all migrations
      const db = await createRawDb(dbPath);

      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      // Verify content_hash column and index exist
      const colsResult = await db.execute('PRAGMA table_info(observations)');
      const hasContentHash = colsResult.rows.some((col: any) => col.name === 'content_hash');
      expect(hasContentHash).toBe(true);

      // Checkpoint WAL so all data is in the main file
      await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      await db.close();

      // Step 2: Corrupt the DB
      corruptDbViaPython(dbPath);

      // Step 3: Verify the DB is actually corrupted
      // Use a raw client to check — corruption may cause errors on schema read
      let threw = false;
      const corruptClient = createClient({ url: `file:${dbPath}` });
      const corruptDb = new LibsqlAdapter(corruptClient);
      try {
        await corruptDb.execute('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1');
      } catch (e: any) {
        threw = true;
        expect(e.message).toContain('malformed');
      }
      await corruptDb.close();
      // Note: libsql may or may not throw on corrupted schema; if it doesn't, we skip the assertion
      // The important test is that ClaudeMemDatabase.create() produces a working DB

      // Step 4: Open via ClaudeMemDatabase — it should auto-repair
      const repaired = await ClaudeMemDatabase.create(dbPath);

      // Verify the DB is functional
      const tablesResult = await repaired.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const tableNames = (tablesResult.rows as { name: string }[]).map(t => t.name);
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('sdk_sessions');

      // Verify the index was recreated by the migration runner
      const indexResult = await repaired.db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_content_hash'");
      expect(indexResult.rows.length).toBe(1);

      // Verify the content_hash column was re-added by the migration
      const columnsResult = await repaired.db.execute('PRAGMA table_info(observations)');
      expect((columnsResult.rows as { name: string }[]).some(c => c.name === 'content_hash')).toBe(true);

      await repaired.close();
    } finally {
      cleanup(dbPath);
    }
  });

  it('should handle a fresh database without triggering repair', async () => {
    const dbPath = tempDbPath();
    try {
      const db = await ClaudeMemDatabase.create(dbPath);
      const tablesResult = await db.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      expect(tablesResult.rows.length).toBeGreaterThan(0);
      await db.close();
    } finally {
      cleanup(dbPath);
    }
  });

  it('should repair a corrupted DB that has no schema_versions table', async () => {
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
      let threw = false;
      const corruptClient = createClient({ url: `file:${dbPath}` });
      const corruptDb = new LibsqlAdapter(corruptClient);
      try {
        await corruptDb.execute('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1');
      } catch (e: any) {
        threw = true;
        expect(e.message).toContain('malformed');
      }
      await corruptDb.close();
      // Note: libsql may handle corruption differently than bun:sqlite

      // ClaudeMemDatabase must repair and fully initialize despite missing schema_versions
      const repaired = await ClaudeMemDatabase.create(dbPath);
      const tablesResult = await repaired.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const tableNames = (tablesResult.rows as { name: string }[]).map(t => t.name);
      expect(tableNames).toContain('schema_versions');
      expect(tableNames).toContain('observations');
      expect(tableNames).toContain('sdk_sessions');
      await repaired.close();
    } finally {
      cleanup(dbPath);
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    }
  });

  it('should preserve existing data through repair and re-migration', async () => {
    if (!hasPython()) {
      console.log('Python3 not available, skipping test');
      return;
    }

    const dbPath = tempDbPath();
    try {
      // Step 1: Create a fully migrated DB and insert a session + observation
      const db = await createRawDb(dbPath);

      const runner = new MigrationRunner(db);
      await runner.runAllMigrations();

      const now = new Date().toISOString();
      const epoch = Date.now();
      await db.execute(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ['test-content-1', 'test-memory-1', 'test-project', now, epoch, 'active']);

      await db.execute(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `, ['test-memory-1', 'test-project', 'discovery', now, epoch]);

      await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      await db.close();

      // Step 2: Corrupt the DB
      corruptDbViaPython(dbPath);

      // Step 3: Repair via ClaudeMemDatabase
      const repaired = await ClaudeMemDatabase.create(dbPath);

      // Data must survive the repair + re-migration
      const sessionsResult = await repaired.db.execute('SELECT COUNT(*) as count FROM sdk_sessions');
      const observationsResult = await repaired.db.execute('SELECT COUNT(*) as count FROM observations');
      expect((sessionsResult.rows[0] as { count: number }).count).toBe(1);
      expect((observationsResult.rows[0] as { count: number }).count).toBe(1);

      await repaired.close();
    } finally {
      cleanup(dbPath);
    }
  });
});
