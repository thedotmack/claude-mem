import { Database } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { MigrationRunner } from './migrations/runner.js';

export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    this.db = new Database(dbPath, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${256 * 1024 * 1024}`);
    this.db.run('PRAGMA cache_size = 10000');

    new MigrationRunner(this.db).runAllMigrations();
  }

  close(): void {
    this.db.close();
  }
}

export { Database };

export { MigrationRunner } from './migrations/runner.js';

export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';
