import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { ensureDir } from '../../shared/paths.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function ensureDatabaseParentDir(dbPath: string): void {
  if (dbPath === ':memory:') return;
  ensureDir(dirname(dbPath));
}

export function applySqliteBusyTimeout(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

export function enableIncrementalAutoVacuumIfFresh(db: Database): boolean {
  const { tableCount } = db
    .query("SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table'")
    .get() as { tableCount: number };
  const { page_count: pageCount } = db
    .query('PRAGMA page_count')
    .get() as { page_count: number };

  if (tableCount > 0 || pageCount > 1) {
    return false;
  }

  db.run('PRAGMA auto_vacuum = INCREMENTAL');
  return true;
}

export function configurePrimarySqliteConnection(db: Database): void {
  applySqliteBusyTimeout(db);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_size_limit = 4194304');
}

export function openPrimarySqliteConnection(dbPath: string): Database {
  ensureDatabaseParentDir(dbPath);
  const db = new Database(dbPath);
  enableIncrementalAutoVacuumIfFresh(db);
  configurePrimarySqliteConnection(db);
  return db;
}
