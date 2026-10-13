import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 4194304;

/**
 * The highest SessionStore migration version this binary's chain knows — the
 * stamp and the refusal compare schema versions, not the plugin semver
 * (#4602 review). Most claude-mem releases don't touch the schema, so a
 * semver comparison refused harmless downgrades as full outages: one bad
 * patch rolled back, two hosts sharing ~/.claude-mem on different bundled
 * versions, the plan-16 stale-plugin-dir spawn. Bump this with every new
 * migration; tests/sqlite/session-store-writer-version.test.ts pins it to
 * MAX(version) FROM schema_versions after a fresh open, so a new migration
 * can't land without it. Kept in this leaf module — both SessionStore and
 * SessionSearch already import from here, and they import each other.
 */
export const LATEST_SCHEMA_VERSION = 65;

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

/**
 * #3609 step 2: the database records the highest schema version its last
 * writer knew, so a binary whose chain stops below that refuses to run
 * migrations or rebuilds instead of silently destroying the newer schema
 * (the 13.4.2-over-schema-49 data loss in the #3609 timeline — an old
 * binary re-running the v7/v9 rebuilds over migrations it doesn't know).
 * Refusing only on a schema-newer stamp keeps everyday plugin downgrades
 * adoptable: an equal or older stamp, and 0 — never written by a stamping
 * binary, the smooth-upgrade path for existing installs — always passes.
 */
export function assertSchemaWriterCompatible(db: Database, latestKnownSchemaVersion: number): void {
  // This read is the first statement on a fresh connection, ahead of the
  // pragmas. Without a busy timeout it fails at once with "database is locked"
  // while another connection is opening the same WAL database, and a worker
  // whose boot fails twice that way is not recycled again. busy_timeout is a
  // per-connection setting, so a refused open still leaves the file untouched.
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const stamp = readSchemaWriterStamp(db);
  if (stamp <= latestKnownSchemaVersion) {
    return;
  }
  throw new SchemaNewerThanBinaryError(
    `SQLite database has schema v${stamp}; this claude-mem knows up to schema v${latestKnownSchemaVersion}. ` +
    `Upgrade claude-mem before opening this database.`,
  );
}

/**
 * Re-read the stamp, refuse a newer schema, and raise (never lower) the stamp
 * to this binary's version. The caller must already hold the SQLite write
 * lock (an IMMEDIATE transaction), so no other writer can stamp between the
 * check and the write.
 */
export function checkAndRaiseSchemaWriterStampInTransaction(db: Database, latestKnownSchemaVersion: number): void {
  assertSchemaWriterCompatible(db, latestKnownSchemaVersion);
  if (readSchemaWriterStamp(db) < latestKnownSchemaVersion) {
    db.run(`PRAGMA user_version = ${latestKnownSchemaVersion}`);
  }
}

/**
 * Atomic check-and-stamp, run before the first schema write (#4602 review).
 * A plain read-then-write let two workers on different schema versions both
 * pass the check before either stamped: the newer one stamped and migrated,
 * then the older one overwrote the stamp and ran its chain over the newer
 * schema. BEGIN IMMEDIATE takes the write lock (waiting up to busy_timeout
 * for a concurrent opener), so the re-check and the stamp commit together,
 * and an older binary that read the stamp earlier is refused here.
 */
export function claimSchemaWriter(db: Database, latestKnownSchemaVersion: number): void {
  db.transaction(() => checkAndRaiseSchemaWriterStampInTransaction(db, latestKnownSchemaVersion)).immediate();
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
 * file, so a database whose schema is newer than this binary's chain must be
 * refused BEFORE the pragmas run — otherwise a refused open still leaves a
 * DELETE-mode file converted to WAL.
 */
export function openGuardedSqliteDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  assertSchemaWriterCompatible(db, LATEST_SCHEMA_VERSION);
  applySqliteConnectionPragmas(db);
  return db;
}
