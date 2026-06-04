import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { existsSync, renameSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';

const RECOVER_MAX_BUFFER_BYTES = 1024 * 1024 * 256;

const MALFORMED_SCHEMA_MARKER = 'malformed database schema';

/**
 * Returns true when an error thrown while reading a SQLite database indicates
 * that the on-disk `sqlite_master` schema is malformed (e.g. an orphaned index
 * referencing a dropped column or a missing backing table). These databases
 * cannot be queried at all — even reading `sqlite_master` re-triggers the parse
 * — so they must be rebuilt before migrations can run.
 */
export function isMalformedSchemaError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes(MALFORMED_SCHEMA_MARKER);
  }
  return false;
}

/**
 * Probes a freshly-opened database connection for a malformed on-disk schema.
 * SQLite parses `sqlite_master` lazily on first access, so a corrupt schema does
 * not surface until the first statement runs. We force that parse here so the
 * caller can decide whether to repair before doing anything destructive.
 *
 * Throws the underlying SQLite error if the schema is malformed; returns
 * normally otherwise.
 */
export function assertSchemaReadable(db: Database): void {
  db.query("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1").all();
}

function removeWalSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
    }
  }
}

/**
 * Rebuilds a database whose `sqlite_master` schema is malformed.
 *
 * Uses the `sqlite3` CLI's `.recover` command, which reconstructs table data
 * directly from b-tree pages and therefore bypasses the broken schema entirely.
 * Orphaned indexes and dropped columns are discarded; surviving rows are
 * preserved. The recovered SQL is materialized into a sidecar database which
 * then atomically replaces the corrupt file. Migrations run afterward to
 * re-establish the canonical schema (re-adding dropped columns/indexes).
 *
 * Returns true if a repair was performed.
 */
export function repairMalformedDatabase(dbPath: string): boolean {
  if (dbPath === ':memory:') {
    return false;
  }

  logger.warn('DB', `Malformed schema detected in ${dbPath}; attempting recovery via sqlite3 .recover`);

  const recoveredPath = `${dbPath}.recovered`;
  if (existsSync(recoveredPath)) {
    unlinkSync(recoveredPath);
  }
  removeWalSidecars(recoveredPath);

  // `.recover` reconstructs table data directly from b-tree pages and emits a
  // self-contained SQL script (including CLI dot-commands and `writable_schema`
  // toggles needed to recreate internal tables like `sqlite_sequence`). That
  // script must be replayed by the sqlite3 CLI itself — bun:sqlite's parser
  // rejects the dot-commands and the reserved `sqlite_sequence` writes. We
  // therefore pipe `.recover` straight into a second CLI invocation that builds
  // the clean sidecar database.
  let recoverSql: string;
  try {
    recoverSql = execFileSync('sqlite3', [dbPath, '.recover'], {
      maxBuffer: RECOVER_MAX_BUFFER_BYTES,
      encoding: 'utf-8',
    });
  } catch (error) {
    throw new Error(
      `Cannot repair malformed database ${dbPath}: the 'sqlite3' CLI is required for .recover but failed (${error instanceof Error ? error.message : String(error)})`
    );
  }

  try {
    execFileSync('sqlite3', [recoveredPath], {
      input: recoverSql,
      maxBuffer: RECOVER_MAX_BUFFER_BYTES,
      encoding: 'utf-8',
    });
  } catch (error) {
    if (existsSync(recoveredPath)) {
      unlinkSync(recoveredPath);
    }
    removeWalSidecars(recoveredPath);
    throw new Error(
      `Cannot repair malformed database ${dbPath}: failed to materialize recovered database (${error instanceof Error ? error.message : String(error)})`
    );
  }

  // Swap the recovered database in for the corrupt original.
  removeWalSidecars(dbPath);
  renameSync(recoveredPath, dbPath);
  removeWalSidecars(recoveredPath);

  logger.info('DB', `Recovered malformed database ${dbPath}; re-running migrations to restore canonical schema`);
  return true;
}
