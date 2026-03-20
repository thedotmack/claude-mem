import { execFileSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';
import type { DbAdapter } from './adapter.js';
import { createDbAdapter } from './adapters/libsql-adapter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

// SQLite configuration constants
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; // 256MB
const SQLITE_CACHE_SIZE_PAGES = 10_000;

export interface Migration {
  version: number;
  up: (db: DbAdapter) => Promise<void>;
  down?: (db: DbAdapter) => Promise<void>;
}

let dbInstance: DbAdapter | null = null;

/**
 * Repair malformed database schema before migrations run.
 *
 * This handles the case where a database is synced between machines running
 * different claude-mem versions. Only applies to local/replica mode (not remote).
 */
function repairMalformedSchemaSync(dbPath: string): void {
  // Only repair file-based databases
  if (!dbPath || dbPath === ':memory:' || dbPath === '') return;
  if (!existsSync(dbPath)) return;

  // Skip for remote mode
  const mode = SettingsDefaultsManager.get('CLAUDE_MEM_DB_MODE');
  if (mode === 'remote') return;

  // Quick test using Python to check schema integrity and repair if needed
  const scriptPath = join(tmpdir(), `claude-mem-probe-${Date.now()}.py`);
  try {
    writeFileSync(scriptPath, `
import sqlite3, sys
db_path = sys.argv[1]
try:
  c = sqlite3.connect(db_path)
  c.execute('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').fetchall()
  c.close()
  sys.exit(0)
except Exception as e:
  msg = str(e)
  if 'malformed database schema' not in msg:
    sys.exit(0)
  import re
  m = re.search(r'malformed database schema \\(([^)]+)\\)', msg)
  if not m:
    print(f"Cannot parse: {msg}", file=sys.stderr)
    sys.exit(1)
  obj_name = m.group(1)
  c = sqlite3.connect(db_path)
  c.execute('PRAGMA writable_schema = ON')
  c.execute('DELETE FROM sqlite_master WHERE name = ?', (obj_name,))
  c.execute('PRAGMA writable_schema = OFF')
  has_sv = c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_versions'").fetchone()[0]
  if has_sv:
    c.execute('DELETE FROM schema_versions')
  c.commit()
  c.close()
  print(f"Repaired: {obj_name}")
`);
    const result = execFileSync('python3', [scriptPath, dbPath], { timeout: 10000 });
    const output = result.toString().trim();
    if (output) {
      logger.info('DB', `Schema repair: ${output}. All migrations will re-run (they are idempotent).`);
    }
  } catch (pyError: unknown) {
    // Best effort — if Python isn't available or fails, we'll catch the error during migration
    const pyMessage = pyError instanceof Error ? pyError.message : String(pyError);
    logger.debug('DB', 'Schema probe skipped', { error: pyMessage });
  } finally {
    if (existsSync(scriptPath)) unlinkSync(scriptPath);
  }
}

/**
 * ClaudeMemDatabase - New entry point for the sqlite module
 *
 * Replaces SessionStore as the database coordinator.
 * Uses @libsql/client with optimized settings and runs all migrations.
 *
 * Usage:
 *   const db = await ClaudeMemDatabase.create();  // uses default DB_PATH
 *   const db = await ClaudeMemDatabase.create('/path/to/db.sqlite');
 *   const db = await ClaudeMemDatabase.create(':memory:');  // for tests
 */
export class ClaudeMemDatabase {
  public db: DbAdapter;

  private constructor(db: DbAdapter) {
    this.db = db;
  }

  /**
   * Create and initialize a ClaudeMemDatabase instance.
   * Constructors can't be async, so we use a static factory.
   */
  static async create(dbPath: string = DB_PATH): Promise<ClaudeMemDatabase> {
    // Ensure data directory exists (skip for in-memory databases)
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    // Repair any malformed schema before opening connection
    if (dbPath !== ':memory:') {
      repairMalformedSchemaSync(dbPath);
    }

    // Create database adapter (respects CLAUDE_MEM_DB_MODE settings)
    const db = await createDbAdapter(dbPath);

    // Apply optimized SQLite settings (skipped for remote mode by the adapter)
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA synchronous = NORMAL');
    await db.execute('PRAGMA foreign_keys = ON');
    await db.execute('PRAGMA temp_store = memory');
    await db.execute(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    await db.execute(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Run all migrations
    const migrationRunner = new MigrationRunner(db);
    await migrationRunner.runAllMigrations();

    return new ClaudeMemDatabase(db);
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    await this.db.close();
  }
}

/**
 * SQLite Database singleton with migration support and optimized settings
 * @deprecated Use ClaudeMemDatabase instead for new code
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: DbAdapter | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  async initialize(): Promise<DbAdapter> {
    if (this.db) {
      return this.db;
    }

    ensureDir(DATA_DIR);

    // Repair schema before opening
    repairMalformedSchemaSync(DB_PATH);

    this.db = await createDbAdapter(DB_PATH);

    // Apply optimized SQLite settings
    await this.db.execute('PRAGMA journal_mode = WAL');
    await this.db.execute('PRAGMA synchronous = NORMAL');
    await this.db.execute('PRAGMA foreign_keys = ON');
    await this.db.execute('PRAGMA temp_store = memory');
    await this.db.execute(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    await this.db.execute(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    // Initialize schema_versions table
    await this.initializeSchemaVersions();

    // Run migrations
    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  getConnection(): DbAdapter {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  private async initializeSchemaVersions(): Promise<void> {
    if (!this.db) return;

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const result = await this.db.execute('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = result.rows.map((row: any) => row.version);
    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions as number[]) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        await this.db.execute('BEGIN');
        try {
          await migration.up(this.db);
          await this.db.execute(
            'INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)',
            [migration.version, new Date().toISOString()]
          );
          await this.db.execute('COMMIT');
        } catch (e) {
          await this.db.execute('ROLLBACK');
          throw e;
        }

        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  async getCurrentVersion(): Promise<number> {
    if (!this.db) return 0;

    const result = await this.db.execute('SELECT MAX(version) as version FROM schema_versions');
    const row = result.rows[0] as { version: number } | undefined;
    return row?.version || 0;
  }
}

/**
 * Get the global database instance (for compatibility)
 */
export function getDatabase(): DbAdapter {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

/**
 * Initialize and get database manager
 */
export async function initializeDatabase(): Promise<DbAdapter> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

// Re-export DbAdapter type instead of bun:sqlite Database
export type { DbAdapter } from './adapter.js';

// Re-export MigrationRunner for external use
export { MigrationRunner } from './migrations/runner.js';

// Re-export all module functions for convenient imports
export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';
