import { Database } from 'bun:sqlite';
import { dirname } from 'path';
import { ensureDir } from '../../shared/paths.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function applySqliteBusyTimeout<T extends Database>(db: T): T {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

export function ensureDatabaseParentDir(dbPath: string): void {
  if (dbPath === ':memory:') {
    return;
  }

  const parentDir = dirname(dbPath);
  if (parentDir === '' || parentDir === '.') {
    return;
  }

  ensureDir(parentDir);
}
