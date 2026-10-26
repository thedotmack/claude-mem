import { existsSync, unlinkSync } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { renameWithWindowsRetry } from '../../shared/atomic-json.js';
import { runSqliteFileJob } from './sqlite-file-job.js';
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
 *      committed row; refuse if another connection holds it. A database too
 *      damaged to checkpoint is still restorable: its -wal is kept with the
 *      pre-restore copy instead.
 *   3. Copy the live database into preRestoreDir as a snapshot-named file,
 *      so `restore` can put it back.
 *   4. Raise the staged AUTOINCREMENT counters to the live ones.
 *   5. Delete the live -wal/-shm (empty after step 2, and they must never sit
 *      next to the new main file), then rename the staged file over the live
 *      one (atomic on one filesystem).
 * A failure before the rename leaves the old database in place and removes
 * the staged copy; nothing is ever copied over the live file.
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

  try {
    await copyFile(snapshotPath, stagedDb);
    if (existsSync(`${snapshotPath}-wal`)) await copyFile(`${snapshotPath}-wal`, `${stagedDb}-wal`);
    await runSqliteFileJob({ kind: 'standalone', target: stagedDb });

    if (existsSync(dbPath)) {
      let liveWalKept = false;
      try {
        const { busy } = await runSqliteFileJob({ kind: 'checkpoint', target: dbPath });
        if (busy) throw Object.assign(new Error('the database is in use by another process; stop it and retry the restore'), { busy: true });
      } catch (error) {
        if ((error as { busy?: boolean }).busy) throw error;
        // SQLITE_BUSY / SQLITE_LOCKED surface as thrown errors when another
        // connection holds a lock: that is "in use", not damage.
        if (error instanceof Error && /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(error.message)) {
          throw new Error(`the database is in use by another process; stop it and retry the restore (${error.message})`);
        }
        liveWalKept = true;
        logger.warn('BACKUP', 'Live database could not be checkpointed; keeping its -wal with the pre-restore copy', {}, error instanceof Error ? error : new Error(String(error)));
      }
      preRestoreCopy = join(options.preRestoreDir, `claude-mem-${ts}-pre-restore.db`);
      await copyFile(dbPath, preRestoreCopy);
      if (liveWalKept && existsSync(`${dbPath}-wal`)) await copyFile(`${dbPath}-wal`, `${preRestoreCopy}-wal`);
      // Read from the live file: it is about to be replaced, so the sidecars
      // this open may leave behind are deleted in the next step.
      carryAutoincrementCounters(stagedDb, readAutoincrementCounters(dbPath));
    }

    for (const ext of SIDECAR_EXTS) removeIfPresent(`${dbPath}${ext}`);
    rename(stagedDb, dbPath);
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
 * reports. Never throws.
 */
export async function applyPendingRestore(dbPath: string, backupsDir: string): Promise<LastRestoreResult | null> {
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
    const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });
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
