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
export const LATEST_SCHEMA_VERSION = 74;

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

/**
 * Force a fresh handle to prove it can read the schema. A bun:sqlite open
 * is lazy: a WAL database whose wal-index cannot be established constructs
 * fine and only fails at the first statement that touches the file, so a
 * caller that merely constructs the handle cannot tell a healthy open from
 * a doomed one (#5429). The busy timeout is set first so a held lock waits
 * the way the caller's own statements would, instead of falling through to
 * the fallback ladder. run() rather than prepare(): the schema read must
 * not leave a prepared statement behind on a handle whose callers account
 * for the statements they prepare.
 */
function probeReaderDatabase(db: Database): Database {
  try {
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.run('PRAGMA schema_version');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Open a database for a reader that must never write to it: the context
 * read worker and context generation (#5429).
 *
 * A read-only handle cannot create the -wal or the wal-index (-shm) of a
 * WAL database. When they are missing, every read fails with "unable to
 * open database file" even though the database itself is healthy and the
 * writer in the same process is working. So:
 *
 * 1. Open read-only, exactly as before.
 * 2. If that fails, a short-lived read-write open creates the -wal and the
 *    wal-index. Hold it while retrying the read-only open, so the handle
 *    the caller reads from is still read-only; the read-write handle is
 *    closed before this returns.
 *
 * When the read-write open cannot help either (a missing or corrupt
 * database, or a data directory this process cannot write), the original
 * read-only error is rethrown, so callers fail the way they did before.
 */
export function openReaderDatabase(dbPath: string): Database {
  let readonlyError: unknown;
  try {
    return probeReaderDatabase(new Database(dbPath, { readonly: true, create: false }));
  } catch (error) {
    readonlyError = error;
  }

  try {
    const establish = new Database(dbPath, { readwrite: true, create: false });
    try {
      probeReaderDatabase(establish);
      const reader = probeReaderDatabase(new Database(dbPath, { readonly: true, create: false }));
      logger.warn('DB', 'Read-only open failed until a read-write open created the -wal and wal-index (#5429)', { dbPath },
        readonlyError instanceof Error ? readonlyError : new Error(String(readonlyError)));
      return reader;
    } finally {
      establish.close();
    }
  } catch (establishError) {
    logger.warn('DB', 'Read-only open failed and a read-write open could not create the -wal and wal-index (#5429)', { dbPath },
      establishError instanceof Error ? establishError : new Error(String(establishError)));
    throw readonlyError;
  }
}
