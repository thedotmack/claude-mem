import { lstatSync, readdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';

/** Only the two staging formats the worker creates, including ordinary SQLite sidecars. */
const PARTIAL_SNAPSHOT_PATTERN = /^claude-mem-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-pre-restore\.db\.partial|\.db\.partial(?:-wal|-shm|-journal)?)$/;

/** Keep this empty file so every worker locks the same inode. Closing the
 * connection (including on process death) releases its SQLite file lock. */
export function openRestoreStagingLock(backupsDir: string): Database {
  return new Database(join(backupsDir, '.restore-staging.lock'));
}

export function removePartialSnapshots(backupsDir: string): void {
  const restorePartials: string[] = [];
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !PARTIAL_SNAPSHOT_PATTERN.test(entry.name)) continue;
    const path = join(backupsDir, entry.name);
    if (entry.name.endsWith('-pre-restore.db.partial')) restorePartials.push(path);
    else unlinkSync(path);
  }
  if (restorePartials.length === 0) return;

  using lock = openRestoreStagingLock(backupsDir);
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') return;
    throw error;
  }
  for (const partial of restorePartials) {
    // A restore could have published between readdir and acquiring the lock.
    if (!lstatSync(partial, { throwIfNoEntry: false })?.isFile()) continue;
    const destination = partial.slice(0, -'.partial'.length);
    if (!lstatSync(destination, { throwIfNoEntry: false })) rmSync(`${destination}-wal`, { force: true });
    unlinkSync(partial);
  }
}
