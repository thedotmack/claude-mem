import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { PathDiscovery } from '../path-discovery.js';

export interface Migration {
  version: number;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

let dbInstance: Database.Database | null = null;

/**
 * SQLite Database singleton with migration support and optimized settings
 */
export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database.Database | null = null;
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
  async initialize(): Promise<Database.Database> {
    if (this.db) {
      return this.db;
    }

    // Ensure the data directory exists
    const dataDir = PathDiscovery.getInstance().getDataDirectory();
    fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = path.join(dataDir, 'claude-mem.db');
    this.db = new Database(dbPath);
    
    // Apply optimized SQLite settings
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = memory');
    this.db.pragma('mmap_size = 268435456'); // 256MB
    this.db.pragma('cache_size = 10000');

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
  getConnection(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Execute a function within a transaction
   */
  withTransaction<T>(fn: (db: Database.Database) => T): T {
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

    this.db.exec(`
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

    const appliedVersions = this.db
      .prepare('SELECT version FROM schema_versions ORDER BY version')
      .all()
      .map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        console.log(`Applying migration ${migration.version}...`);
        
        const transaction = this.db.transaction(() => {
          migration.up(this.db!);
          
          this.db!
            .prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
            .run(migration.version, new Date().toISOString());
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

    const result = this.db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

/**
 * Get the global database instance (for compatibility)
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

/**
 * Initialize and get database manager
 */
export async function initializeDatabase(): Promise<Database.Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { Database };