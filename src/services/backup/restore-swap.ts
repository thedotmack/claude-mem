import { existsSync, renameSync as fsRenameSync, unlinkSync } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { renameWithWindowsRetry } from '../../shared/atomic-json.js';
import { runSqliteFileJob } from './sqlite-file-job.js';
import { ChromaSyncState } from '../sync/ChromaSyncState.js';
import {
  clearPendingRestore,
  readPendingRestore,
  resolveSnapshotInside,
  writeLastRestoreResult,
  type LastRestoreResult,
} from './snapshot-files.js';

const SIDECAR_EXTS = ['-wal', '-shm'] as const;

export interface SwapResult {
  preRestoreCopy: string | null;
}

export interface SwapOptions {
  /** Where the copy of the replaced database goes (a snapshot-named file, so it can be restored). */
  preRestoreDir: string;
  /** Test seam for the one step whose failure the swap must survive. */
  renameSync?: (from: string, to: string) => void;
  /**
   * How long to keep retrying while another process holds the live database
   * (0 = fail at once). See applyPendingRestore for where the window comes from.
   */
  busyRetryWindowMs?: number;
}

/** Pause between "in use" retries: short next to the retry window, long next to a checkpoint. */
const BUSY_RETRY_INTERVAL_MS = 500;

const IN_USE_MESSAGE = 'the database is in use by another process; stop it and retry the restore';

class DatabaseInUseError extends Error {}

/**
 * Checkpoint the live database in the child process. Throws DatabaseInUseError
 * when another connection holds it, and returns false when the file is too
 * damaged to checkpoint at all.
 */
async function checkpointLiveDatabase(dbPath: string): Promise<boolean> {
  try {
    const { busy } = await runSqliteFileJob({ kind: 'checkpoint', target: dbPath });
    if (busy) throw new DatabaseInUseError(IN_USE_MESSAGE);
    return true;
  } catch (error) {
    if (error instanceof DatabaseInUseError) throw error;
    // SQLITE_BUSY / SQLITE_LOCKED surface as thrown errors when another
    // connection holds a lock: that is "in use", not damage.
    if (error instanceof Error && /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(error.message)) {
      throw new DatabaseInUseError(`${IN_USE_MESSAGE} (${error.message})`);
    }
    logger.warn('BACKUP', 'Live database could not be checkpointed; keeping its -wal with the pre-restore copy', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

async function checkpointWithRetry(dbPath: string, retryWindowMs: number): Promise<boolean> {
  const giveUpAt = Date.now() + retryWindowMs;
  for (;;) {
    try {
      return await checkpointLiveDatabase(dbPath);
    } catch (error) {
      if (!(error instanceof DatabaseInUseError) || Date.now() + BUSY_RETRY_INTERVAL_MS > giveUpAt) throw error;
      await new Promise(resolve => setTimeout(resolve, BUSY_RETRY_INTERVAL_MS));
    }
  }
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * The live database's AUTOINCREMENT counters. Best effort: a database too
 * damaged to read them yields none, and the restore still goes ahead.
 */
function readAutoincrementCounters(dbPath: string): Array<{ name: string; seq: number }> {
  try {
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
      if (!hasTable) return [];
      return db.query('SELECT name, seq FROM sqlite_sequence').all() as Array<{ name: string; seq: number }>;
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn('BACKUP', 'Could not read the live database AUTOINCREMENT counters; restored ids may repeat', { dbPath }, error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

/**
 * Raise the staged database's AUTOINCREMENT counters to at least the live
 * ones, so rows written after the restore never reuse an id the replaced
 * database already handed out. Chroma documents and cloud-sync ops are keyed
 * by those ids; a reused id would attach old vectors or a stale origin id to
 * a new row.
 */
function carryAutoincrementCounters(stagedDb: string, counters: Array<{ name: string; seq: number }>): void {
  if (counters.length === 0) return;
  const db = new Database(stagedDb, { readwrite: true, create: false });
  try {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
    if (!tables.has('sqlite_sequence')) return;
    const raise = db.prepare('UPDATE sqlite_sequence SET seq = ?1 WHERE name = ?2 AND seq < ?1');
    const insert = db.prepare('INSERT INTO sqlite_sequence (name, seq) SELECT ?2, ?1 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?2)');
    db.transaction(() => {
      for (const { name, seq } of counters) {
        if (!tables.has(name)) continue;
        raise.run(seq, name);
        insert.run(seq, name);
      }
    })();
    raise.finalize();
    insert.finalize();
  } finally {
    db.close();
  }
}

/**
 * Replace the live database with a snapshot, crash-consistently. The heavy
 * whole-file steps run in a child process (sqlite-file-job.ts), so the worker
 * keeps answering requests while a multi-GB restore runs.
 *
 * Order matters. At every point a crash leaves either the old database or
 * the new one, each complete in its main file:
 *   1. Stage a copy of the snapshot (and its -wal, if any) next to the live
 *      file and make it one standalone, quick_check-verified file. Nothing
 *      live has been touched yet.
 *   2. Checkpoint the live database (TRUNCATE) so its main file holds every
 *      committed row; refuse if another connection holds it.
 *   3. Copy the live main file into preRestoreDir as a snapshot-named file,
 *      so `restore` can put it back. A database too damaged to checkpoint is
 *      still restorable; its copy is the db and -wal as they were on disk
 *      before anything opened them.
 *   4. Raise the staged AUTOINCREMENT counters to the live ones.
 *   5. Move the live -wal/-shm aside (they must never sit next to the new
 *      main file), then rename the staged file over the live one (atomic on
 *      one filesystem).
 * A failure before the rename leaves the old database in place, with its
 * sidecars moved back, and removes the staged copy; nothing is ever copied
 * over the live file.
 */
export async function swapDatabaseFromSnapshot(
  dbPath: string,
  snapshotPath: string,
  options: SwapOptions,
): Promise<SwapResult> {
  if (!existsSync(snapshotPath)) {
    throw new Error(`snapshot not found: ${snapshotPath}`);
  }
  const rename = options.renameSync ?? ((from: string, to: string) => renameWithWindowsRetry(from, to));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stagedDb = `${dbPath}.restore-staging-${ts}`;
  let preRestoreCopy: string | null = null;
  const movedSidecars: string[] = [];

  try {
    await copyFile(snapshotPath, stagedDb);
    if (existsSync(`${snapshotPath}-wal`)) await copyFile(`${snapshotPath}-wal`, `${stagedDb}-wal`);
    await runSqliteFileJob({ kind: 'standalone', target: stagedDb });

    if (existsSync(dbPath)) {
      // Keep a byte-for-byte copy of the live db and its -wal before anything
      // opens them: opening a damaged database can make SQLite discard its
      // WAL, and for such a database this copy is the only way back.
      const copyPath = join(options.preRestoreDir, `claude-mem-${ts}-pre-restore.db`);
      const rawCopy = `${dbPath}.restore-raw-${ts}`;
      await copyFile(dbPath, rawCopy);
      if (existsSync(`${dbPath}-wal`)) await copyFile(`${dbPath}-wal`, `${rawCopy}-wal`);
      const dropRawCopy = (): void => {
        removeIfPresent(rawCopy);
        removeIfPresent(`${rawCopy}-wal`);
      };

      let checkpointed: boolean;
      try {
        checkpointed = await checkpointWithRetry(dbPath, options.busyRetryWindowMs ?? 0);
      } catch (error) {
        // Refused: the live database stays as it is and needs no copy.
        dropRawCopy();
        throw error;
      }
      if (checkpointed) {
        // Nothing else holds the database now and its main file has every
        // committed row, so copy that one file. The raw pair could have been
        // taken mid-checkpoint by another process, so it is not kept.
        dropRawCopy();
        await copyFile(dbPath, copyPath);
        // Read from the live file: it is about to be replaced, so the
        // sidecars this open may leave behind are moved aside next.
        carryAutoincrementCounters(stagedDb, readAutoincrementCounters(dbPath));
      } else {
        // Too damaged to open, so nothing else can be using it either: the
        // raw pair is the best copy there is.
        renameWithWindowsRetry(rawCopy, copyPath);
        if (existsSync(`${rawCopy}-wal`)) renameWithWindowsRetry(`${rawCopy}-wal`, `${copyPath}-wal`);
        logger.warn('BACKUP', 'Restoring over a database that could not be read; new ids may repeat ids it used', { dbPath });
      }
      preRestoreCopy = copyPath;
    }

    // Move the live sidecars aside rather than deleting them: if the rename
    // below fails they go back, so a -wal that still held committed frames
    // (a database too damaged to checkpoint) is never lost.
    for (const ext of SIDECAR_EXTS) {
      if (existsSync(`${dbPath}${ext}`)) {
        fsRenameSync(`${dbPath}${ext}`, `${stagedDb}.live${ext}`);
        movedSidecars.push(ext);
      }
    }
    rename(stagedDb, dbPath);
  } catch (error) {
    for (const ext of movedSidecars) {
      try {
        fsRenameSync(`${stagedDb}.live${ext}`, `${dbPath}${ext}`);
      } catch (restoreError) {
        logger.error('BACKUP', 'Could not put a live sidecar back after a failed restore', { sidecar: `${dbPath}${ext}`, parkedAt: `${stagedDb}.live${ext}` }, restoreError instanceof Error ? restoreError : new Error(String(restoreError)));
      }
    }
    const rawCopy = `${dbPath}.restore-raw-${ts}`;
    for (const leftover of [stagedDb, ...SIDECAR_EXTS.map(ext => `${stagedDb}${ext}`), rawCopy, `${rawCopy}-wal`]) {
      try {
        removeIfPresent(leftover);
      } catch (cleanupError) {
        logger.warn('BACKUP', 'Could not remove restore staging file', { leftover }, cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // The swap is done; the old sidecars belong to the replaced database.
  for (const ext of movedSidecars) removeIfPresent(`${stagedDb}.live${ext}`);
  logger.info('BACKUP', 'Database swapped from snapshot', { snapshot: snapshotPath, preRestoreCopy });
  return { preRestoreCopy };
}

/**
 * The semantic index still describes the replaced database: rows deleted or
 * edited after the snapshot come back older than their vectors, and the
 * backfill watermarks sit past them. Flag every project for a rebuild from
 * zero, the same path a dropped corrupt collection takes; the next backfill
 * re-upserts every row. Failure only leaves search stale, so it is logged.
 */
function queueSemanticIndexRebuild(): void {
  try {
    ChromaSyncState.markAllForRebuild();
  } catch (error) {
    logger.error('BACKUP', 'Could not flag the semantic index for a rebuild after the restore; semantic search may miss restored rows', {}, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Apply a restore staged by `npx claude-mem restore`, before anything in
 * this process opens the database. The marker is cleared as soon as it is
 * read, so a restore that fails is reported once and never retried on every
 * boot. The outcome goes to last-restore.json, which GET /api/backup/status
 * reports. Never throws.
 */
export async function applyPendingRestore(
  dbPath: string,
  backupsDir: string,
  options: { busyRetryWindowMs?: number } = {},
): Promise<LastRestoreResult | null> {
  let snapshot = '(unreadable restore marker)';
  let result: LastRestoreResult;
  try {
    const pending = readPendingRestore();
    if (pending === null) return null;
    snapshot = pending.snapshot;
    clearPendingRestore();
    const snapshotPath = resolveSnapshotInside(backupsDir, pending.snapshot);
    if (snapshotPath === null) {
      throw new Error(`refusing a restore target outside the backups directory: ${pending.snapshot}`);
    }
    const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshotPath, {
      preRestoreDir: backupsDir,
      busyRetryWindowMs: options.busyRetryWindowMs,
    });
    result = { snapshot, at: Date.now(), ok: true, preRestoreCopy, error: null };
    logger.info('BACKUP', 'Pending restore applied', { snapshot, preRestoreCopy });
    queueSemanticIndexRebuild();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    // A marker that cannot be read or applied is cleared, never retried on
    // every boot; the failure is reported through last-restore.json.
    try {
      clearPendingRestore();
    } catch (clearError) {
      logger.error('BACKUP', 'Could not clear the restore marker', {}, clearError instanceof Error ? clearError : new Error(String(clearError)));
    }
    result = { snapshot, at: Date.now(), ok: false, preRestoreCopy: null, error: normalized.message };
    logger.error('BACKUP', 'Pending restore FAILED; the worker is starting on the unchanged database', { snapshot }, normalized);
  }
  try {
    writeLastRestoreResult(result);
  } catch (error) {
    logger.error('BACKUP', 'Could not record the restore outcome in last-restore.json', { ok: result.ok }, error instanceof Error ? error : new Error(String(error)));
  }
  return result;
}
