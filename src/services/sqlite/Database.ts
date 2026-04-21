import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';

// SQLite configuration constants
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; // 256MB
const SQLITE_CACHE_SIZE_PAGES = 10_000;

/**
 * Repair malformed database schema before migrations run.
 *
 * This handles the case where a database is synced between machines running
 * different claude-mem versions. A newer version may have added columns and
 * indexes that an older version (or even the same version on a fresh install)
 * cannot process. SQLite throws "malformed database schema" when it encounters
 * an index referencing a non-existent column, which prevents ALL queries —
 * including the migrations that would fix the schema.
 *
 * The fix: use Python's sqlite3 module (which supports writable_schema) to
 * drop the orphaned schema objects, then let the migration system recreate
 * them properly. bun:sqlite doesn't allow DELETE FROM sqlite_master even
 * with writable_schema = ON.
 */
function repairMalformedSchema(db: Database): void {
  try {
    // Quick test: if we can query sqlite_master, the schema is fine
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    logger.warn('DB', 'Detected malformed database schema, attempting repair', { error: message });

    // Extract the problematic object name from the error message
    // Format: "malformed database schema (object_name) - details"
    const match = message.match(/malformed database schema \(([^)]+)\)/);
    if (!match) {
      logger.error('DB', 'Could not parse malformed schema error, cannot auto-repair', { error: message });
      throw error;
    }

    const objectName = match[1];
    logger.info('DB', `Dropping malformed schema object: ${objectName}`);

    // Get the DB file path. For file-based DBs, we can use Python to repair.
    // For in-memory DBs, we can't shell out — just re-throw.
    const dbPath = db.filename;
    if (!dbPath || dbPath === ':memory:' || dbPath === '') {
      logger.error('DB', 'Cannot auto-repair in-memory database');
      throw error;
    }

    // Close the connection so Python can safely modify the file
    db.close();

    // Use Python's sqlite3 module to drop the orphaned object and reset
    // related migration versions so they re-run and recreate things properly.
    // bun:sqlite doesn't support DELETE FROM sqlite_master even with writable_schema.
    //
    // We write a temp script rather than using -c to avoid shell escaping issues
    // with paths containing spaces or special characters. execFileSync passes
    // args directly without a shell, so dbPath and objectName are safe.
    const scriptPath = join(tmpdir(), `claude-mem-repair-${Date.now()}.py`);
    try {
      writeFileSync(scriptPath, `
import sqlite3, sys
db_path = sys.argv[1]
obj_name = sys.argv[2]
c = sqlite3.connect(db_path)
c.execute('PRAGMA writable_schema = ON')
c.execute('DELETE FROM sqlite_master WHERE name = ?', (obj_name,))
c.execute('PRAGMA writable_schema = OFF')
# Reset migration versions so affected migrations re-run.
# Guard with existence check: schema_versions may not exist on a very fresh DB.
has_sv = c.execute(
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_versions'"
).fetchone()[0]
if has_sv:
  c.execute('DELETE FROM schema_versions')
c.commit()
c.close()
`);
      execFileSync('python3', [scriptPath, dbPath, objectName], { timeout: 10000 });
      logger.info('DB', `Dropped orphaned schema object "${objectName}" and reset migration versions via Python sqlite3. All migrations will re-run (they are idempotent).`);
    } catch (pyError: unknown) {
      const pyMessage = pyError instanceof Error ? pyError.message : String(pyError);
      logger.error('DB', 'Python sqlite3 repair failed', { error: pyMessage });
      throw new Error(`Schema repair failed: ${message}. Python repair error: ${pyMessage}`);
    } finally {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    }
  }
}

/**
 * Wrapper that handles the close/reopen cycle needed for schema repair.
 * Returns a (possibly new) Database connection.
 */
function repairMalformedSchemaWithReopen(dbPath: string, db: Database): Database {
  try {
    db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
    return db;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('malformed database schema')) {
      throw error;
    }

    // repairMalformedSchema closes the DB internally for Python access
    repairMalformedSchema(db);

    // Reopen and check for additional malformed objects
    const newDb = new Database(dbPath, { create: true, readwrite: true });
    return repairMalformedSchemaWithReopen(dbPath, newDb);
  }
}

/**
 * ClaudeMemDatabase - New entry point for the sqlite module
 *
 * Replaces SessionStore as the database coordinator.
 * Sets up bun:sqlite with optimized settings and runs all migrations.
 *
 * Usage:
 *   const db = new ClaudeMemDatabase();  // uses default DB_PATH
 *   const db = new ClaudeMemDatabase('/path/to/db.sqlite');
 *   const db = new ClaudeMemDatabase(':memory:');  // for tests
 */
export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists (skip for in-memory databases)
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    // Create database connection
    this.db = new Database(dbPath, { create: true, readwrite: true });

    // Repair any malformed schema before applying settings or running migrations.
    // Must happen first — even PRAGMA calls can fail on a corrupted schema.
    // This may close and reopen the connection if repair is needed.
    this.db = repairMalformedSchemaWithReopen(dbPath, this.db);

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Run all migrations
    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Re-export bun:sqlite Database type
export { Database };

// Re-export MigrationRunner for external use
export { MigrationRunner } from './migrations/runner.js';

// Re-export all module functions for convenient imports
export * from './sessions/types.js';
export * from './sessions/create.js';
export * from './sessions/get.js';
export * from './observations/types.js';
export * from './observations/store.js';
export * from './observations/get.js';
export * from './observations/recent.js';
export * from './observations/files.js';
export * from './summaries/types.js';
export * from './summaries/store.js';
export * from './summaries/get.js';
export * from './summaries/recent.js';
export * from './prompts/types.js';
export * from './prompts/store.js';
export * from './prompts/get.js';
export * from './timeline/queries.js';
export * from './import/bulk.js';
export * from './transactions.js';