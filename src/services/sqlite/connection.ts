import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 4194304;

type DatabaseOptions = NonNullable<ConstructorParameters<typeof Database>[1]>;

export interface SqlitePragmaOptions {
  enableWal?: boolean;
  enableIncrementalAutoVacuum?: boolean;
}

function hasUserTables(db: Database): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get() as { name: string } | undefined;
  return row != null;
}

function runRequiredPragma(db: Database, sql: string, name: string): void {
  try {
    db.run(sql);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('DB', `Failed to apply SQLite pragma ${name}`, { sql }, err);
    throw error;
  }
}

export function applySqliteConnectionPragmas(
  db: Database,
  options: SqlitePragmaOptions = {},
): void {
  const {
    enableWal = true,
    enableIncrementalAutoVacuum = true,
  } = options;

  runRequiredPragma(db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`, 'busy_timeout');
  runRequiredPragma(db, 'PRAGMA foreign_keys = ON', 'foreign_keys');
  runRequiredPragma(db, 'PRAGMA synchronous = NORMAL', 'synchronous');
  runRequiredPragma(db, `PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`, 'journal_size_limit');

  if (enableIncrementalAutoVacuum && !hasUserTables(db)) {
    runRequiredPragma(db, 'PRAGMA auto_vacuum = INCREMENTAL', 'auto_vacuum');
  }

  if (enableWal) {
    runRequiredPragma(db, 'PRAGMA journal_mode = WAL', 'journal_mode');
  }
}

export function openConfiguredSqliteDatabase(
  dbPath: string,
  options?: DatabaseOptions,
  pragmas?: SqlitePragmaOptions,
): Database {
  const db = new Database(dbPath, options);
  applySqliteConnectionPragmas(db, pragmas);
  return db;
}
