import { copyFileSync, existsSync, unlinkSync } from 'fs';
import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { renameWithWindowsRetry } from '../../shared/atomic-json.js';
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

/** Test seam for the one step whose failure the swap must survive. */
export interface SwapFsOps {
  renameSync: (from: string, to: string) => void;
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Turn a copied database file into one standalone, verified file: fold any
 * WAL into it, switch it to rollback-journal mode (so opening it later never
 * needs or creates sidecars) and require `PRAGMA quick_check` to pass.
 * Throws on a file that is not a healthy SQLite database.
 */
export function makeStandaloneDatabaseFile(path: string): void {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.run('PRAGMA journal_mode = DELETE');
    const check = db.query('PRAGMA quick_check').get() as { quick_check: string } | null;
    if (check?.quick_check !== 'ok') {
      throw new Error(`database failed quick_check: ${check?.quick_check ?? 'no result'}`);
    }
  } finally {
    db.close();
  }
  for (const ext of SIDECAR_EXTS) removeIfPresent(`${path}${ext}`);
}

/**
 * Fold the live database's WAL into its main file so the main file alone
 * holds every committed row. Throws when another connection holds a read or
 * write transaction, because swapping under a live connection would lose its
 * writes.
 */
function checkpointLiveDatabase(dbPath: string): void {
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | null;
    if (result && result.busy !== 0) {
      throw new Error('the database is in use by another process; stop it and retry the restore');
    }
  } finally {
    db.close();
  }
}

/**
 * Replace the live database with a snapshot, crash-consistently.
 *
 * Order matters. At every point a crash leaves either the old database or
 * the new one, each complete in its main file:
 *   1. Stage a copy of the snapshot next to the live file and make it a
 *      standalone, verified file. Nothing live has been touched yet.
 *   2. Checkpoint the live database (TRUNCATE), so its main file holds every
 *      committed row and its WAL is empty; refuse if anything holds it open.
 *   3. Copy that main file to `<db>.pre-restore-<ts>`, itself made a
 *      standalone file so it can be restored or opened on its own.
 *   4. Delete the live -wal/-shm. They are empty after step 2, so the old
 *      main file is still complete without them, and they must never sit
 *      next to the new main file.
 *   5. Rename the staged file over the live one (atomic on one filesystem).
 * A failure before step 5 leaves the old database in place and removes the
 * staged copy; nothing is ever copied over the live file.
 */
export function swapDatabaseFromSnapshot(
  dbPath: string,
  snapshotPath: string,
  fsOps: SwapFsOps = { renameSync: (from, to) => renameWithWindowsRetry(from, to) },
): SwapResult {
  if (!existsSync(snapshotPath)) {
    throw new Error(`snapshot not found: ${snapshotPath}`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stagedDb = `${dbPath}.restore-staging-${ts}`;
  let preRestoreCopy: string | null = null;

  try {
    copyFileSync(snapshotPath, stagedDb);
    makeStandaloneDatabaseFile(stagedDb);

    if (existsSync(dbPath)) {
      checkpointLiveDatabase(dbPath);
      preRestoreCopy = `${dbPath}.pre-restore-${ts}`;
      copyFileSync(dbPath, preRestoreCopy);
      makeStandaloneDatabaseFile(preRestoreCopy);
    }

    for (const ext of SIDECAR_EXTS) removeIfPresent(`${dbPath}${ext}`);
    fsOps.renameSync(stagedDb, dbPath);
  } catch (error) {
    for (const leftover of [stagedDb, ...SIDECAR_EXTS.map(ext => `${stagedDb}${ext}`)]) {
      try {
        removeIfPresent(leftover);
      } catch (cleanupError) {
        logger.warn('BACKUP', 'Could not remove restore staging file', { leftover }, cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  logger.info('BACKUP', 'Database swapped from snapshot', { snapshot: snapshotPath, preRestoreCopy });
  return { preRestoreCopy };
}

/**
 * Apply a restore staged by `npx claude-mem restore`, before anything in
 * this process opens the database. The marker is cleared as soon as it is
 * read, so a restore that fails is reported once and never retried on every
 * boot. The outcome goes to last-restore.json, which GET /api/backup/status
 * reports.
 */
export function applyPendingRestore(dbPath: string, backupsDir: string): LastRestoreResult | null {
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
    const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snapshotPath);
    result = { snapshot, at: Date.now(), ok: true, preRestoreCopy, error: null };
    logger.info('BACKUP', 'Pending restore applied', { snapshot, preRestoreCopy });
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
