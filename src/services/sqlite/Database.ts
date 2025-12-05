import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';

// Runtime detection
const isBun = typeof (globalThis as any).Bun !== 'undefined';

// Unified database interface matching bun:sqlite API
interface UnifiedDatabase {
  run(sql: string, ...params: any[]): any;
  query(sql: string): { all(...params: any[]): any[]; get(...params: any[]): any; run(...params: any[]): any };
  transaction<T>(fn: (db: any) => T): (db: any) => T;
  close(): void;
}

// Wrapper to normalize better-sqlite3 API to match bun:sqlite
function wrapBetterSqlite(BetterSqlite3: any): any {
  return class WrappedDatabase {
    private db: any;

    constructor(path: string, options?: { create?: boolean; readwrite?: boolean; readonly?: boolean }) {
      // Convert bun:sqlite options to better-sqlite3 options
      const betterOptions: any = {};
      if (options?.readonly) betterOptions.readonly = true;
      if (options?.create === false) betterOptions.fileMustExist = true;
      this.db = new BetterSqlite3(path, betterOptions);
    }

    run(sql: string, ...params: any[]) {
      return this.db.prepare(sql).run(...params);
    }

    query(sql: string) {
      const stmt = this.db.prepare(sql);
      return {
        all: (...params: any[]) => stmt.all(...params),
        get: (...params: any[]) => stmt.get(...params),
        run: (...params: any[]) => stmt.run(...params)
      };
    }

    transaction<T>(fn: (db: any) => T): (db: any) => T {
      return this.db.transaction(fn);
    }

    close() {
      this.db.close();
    }
  };
}

// Lazy-loaded SQLite implementation (avoids loading better-sqlite3 under Bun)
let DatabaseImpl: any = null;

async function getSqliteImpl(): Promise<any> {
  if (!DatabaseImpl) {
    // Use indirect require to prevent esbuild from statically analyzing imports
    const dynamicRequire = new Function('m', 'return require(m)');
    if (isBun) {
      DatabaseImpl = dynamicRequire('bun:sqlite').Database;
    } else {
      const BetterSqlite3 = dynamicRequire('better-sqlite3');
      DatabaseImpl = wrapBetterSqlite(BetterSqlite3);
    }
  }
  return DatabaseImpl;
}

type Database = UnifiedDatabase;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

/**
 * SQLite Database singleton with migration support and optimized settings
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Register a migration to be run during initialization
   */
  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    // Keep migrations sorted by version
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Initialize database connection with optimized settings
   */
  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    // Ensure the data directory exists
    ensureDir(DATA_DIR);

    // Lazy load the right SQLite implementation
    const SqliteDb = await getSqliteImpl();
    this.db = new SqliteDb(DB_PATH, { create: true, readwrite: true });

    // Apply optimized SQLite settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run('PRAGMA mmap_size = 268435456'); // 256MB
    this.db.run('PRAGMA cache_size = 10000');

    // Initialize schema_versions table
    this.initializeSchemaVersions();

    // Run migrations
    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  /**
   * Get the current database connection
   */
  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a function within a transaction
   */
  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  /**
   * Initialize the schema_versions table
   */
  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Run all pending migrations
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        console.log(`Applying migration ${migration.version}...`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        console.log(`Migration ${migration.version} applied successfully`);
      }
    }
  }

  /**
   * Get current schema version
   */
  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

/**
 * Get the global database instance (for compatibility)
 */
export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

/**
 * Initialize and get database manager
 */
export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { getSqliteImpl };