import { copyFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';

const SIDECAR_EXTS = ['-wal', '-shm'] as const;

export interface SwapResult {
  preRestoreCopy: string | null;
}

/**
 * Replace the live database with a snapshot, safely.
 *
 * - Fallback snapshots carry committed frames in their `-wal` sidecar, so
 *   snapshot sidecars are restored when present; destination sidecars are
 *   removed only when the snapshot has none (stale sidecars would corrupt a
 *   VACUUM'd snapshot).
 * - Everything is staged next to the destination first, so a copy failure
 *   aborts before the live database is touched, and the final main-file swap
 *   is a same-filesystem rename (atomic).
 * - On a swap failure the pre-restore copy (including its sidecars) is put
 *   back, so the next boot never sees a half-written database.
 */
export function swapDatabaseFromSnapshot(dbPath: string, snapshotPath: string): SwapResult {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // Pre-restore safety copy of the current DB and any live sidecars.
  const preRestoreCopy = existsSync(dbPath) ? `${dbPath}.pre-restore-${ts}` : null;
  if (preRestoreCopy) {
    copyFileSync(dbPath, preRestoreCopy);
    for (const ext of SIDECAR_EXTS) {
      if (existsSync(`${dbPath}${ext}`)) copyFileSync(`${dbPath}${ext}`, `${preRestoreCopy}${ext}`);
    }
  }

  // Stage the snapshot (and its sidecars, if any) next to the destination.
  const stagedDb = `${dbPath}.restore-staging-${ts}`;
  copyFileSync(snapshotPath, stagedDb);
  const sidecars = SIDECAR_EXTS.map(ext => {
    const present = existsSync(`${snapshotPath}${ext}`);
    const staged = `${stagedDb}${ext}`;
    if (present) copyFileSync(`${snapshotPath}${ext}`, staged);
    return { ext, staged, dest: `${dbPath}${ext}`, present };
  });

  try {
    for (const { staged, dest, present } of sidecars) {
      if (existsSync(dest)) unlinkSync(dest);
      if (present) renameSync(staged, dest);
    }
    renameSync(stagedDb, dbPath);
    logger.info('BACKUP', 'Database swapped from snapshot', {
      snapshot: snapshotPath,
      sidecarsRestored: sidecars.filter(s => s.present).map(s => s.ext),
      preRestoreCopy,
    });
    return { preRestoreCopy };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    logger.error('BACKUP', 'Swap failed; rolling back to pre-restore copy', { snapshot: snapshotPath }, normalized);
    if (preRestoreCopy && existsSync(preRestoreCopy)) {
      copyFileSync(preRestoreCopy, dbPath);
      for (const { ext, dest } of sidecars) {
        if (existsSync(dest)) unlinkSync(dest);
        if (existsSync(`${preRestoreCopy}${ext}`)) copyFileSync(`${preRestoreCopy}${ext}`, dest);
      }
    }
    for (const staged of [stagedDb, ...sidecars.map(s => s.staged)]) {
      try {
        if (existsSync(staged)) unlinkSync(staged);
      } catch {
        // best-effort staging cleanup; the rollback above already ran
      }
    }
    throw normalized;
  }
}
