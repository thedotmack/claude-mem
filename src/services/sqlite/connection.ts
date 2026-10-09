import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 4194304;

// The running binary's version, from the build-time define (same resolution
// as worker-service.ts). '0.0.0-dev' when running unbundled, e.g. under
// `bun test`: databases it writes carry stamp 0 and are never refused, while
// any positive stamp still refuses the unbundled binary.
declare const __DEFAULT_PACKAGE_VERSION__: string;
export const CURRENT_BINARY_VERSION: string =
  typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

/**
 * #3609 step 2: the database records which binary version last wrote it, so a
 * binary older than that stamp refuses to run migrations or rebuilds instead
 * of silently destroying the newer schema (the 13.4.2-over-schema-49 data
 * loss in the #3609 timeline). The stamp lives in PRAGMA user_version, coded
 * as major*1_000_000 + minor*1_000 + patch — int32-safe for any plausible
 * version — with prerelease suffixes compared by their base, matching
 * parseBase in compareVersionsDescending.
 */
export function encodeSchemaWriterVersion(version: string): number {
  const parts = version.split('-')[0].split('.');
  return (parseInt(parts[0], 10) || 0) * 1_000_000
    + (parseInt(parts[1], 10) || 0) * 1_000
    + (parseInt(parts[2], 10) || 0);
}

export function decodeSchemaWriterStamp(stamp: number): string {
  return `${Math.floor(stamp / 1_000_000)}.${Math.floor((stamp % 1_000_000) / 1_000)}.${stamp % 1_000}`;
}

export function readSchemaWriterStamp(db: Database): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export class SchemaNewerThanBinaryError extends Error {
  readonly reason = 'schema_newer_than_binary' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SchemaNewerThanBinaryError';
  }
}

export function assertSchemaWriterCompatible(db: Database, binaryVersion: string): void {
  const stamp = readSchemaWriterStamp(db);
  const current = encodeSchemaWriterVersion(binaryVersion);
  // A stamp of 0 means "never written by a stamping binary" and is adopted,
  // never refused — the smooth-upgrade path for existing installs.
  if (stamp <= current) {
    return;
  }
  const writerVersion = decodeSchemaWriterStamp(stamp);
  throw new SchemaNewerThanBinaryError(
    `SQLite database was last written by claude-mem ${writerVersion} (user_version ${stamp}); ` +
    `this binary is ${binaryVersion} (user_version ${current}). ` +
    `Upgrade claude-mem to ${writerVersion} or newer before opening this database.`,
  );
}

export function stampSchemaWriterVersion(db: Database, binaryVersion: string): void {
  db.run(`PRAGMA user_version = ${encodeSchemaWriterVersion(binaryVersion)}`);
}

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

/**
 * Shared-connection open path with the writer guard first (#4602 review):
 * PRAGMA journal_mode = WAL is itself a persistent change to the database
 * file, so a database last written by a newer binary must be refused BEFORE
 * the pragmas run — otherwise a refused open still leaves a DELETE-mode file
 * converted to WAL.
 */
export function openGuardedSqliteDatabase(dbPath: string, binaryVersion: string): Database {
  const db = new Database(dbPath);
  assertSchemaWriterCompatible(db, binaryVersion);
  applySqliteConnectionPragmas(db);
  return db;
}
