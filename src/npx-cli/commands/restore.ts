/**
 * `npx claude-mem restore <file>` — replace claude-mem.db from a local
 * snapshot (pro-backup plan Phase 2).
 *
 * Preferred path: POST /api/backup/restore on the running worker, which
 * closes the DB cleanly, swaps the file, and self-recycles so the supervisor
 * restarts it on the restored database. When the worker is not running, a
 * direct-fs fallback performs the same swap (pre-restore copy of the current
 * DB, snapshot copied over claude-mem.db, stale -wal/-shm removed).
 */

import { copyFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { styleText } from 'node:util';
import { DB_PATH, paths } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

function printRestoreUsage(): void {
  console.error(`Usage: npx claude-mem restore <file>`);
  console.error(`List snapshots with: npx claude-mem backup list`);
}

/**
 * Resolve the requested snapshot inside the backups dir, refusing path
 * traversal (`../../etc/passwd`) — same resolve + prefix check as the worker
 * route. Exits with an error when the file is outside the dir or missing.
 */
function resolveSnapshotOrExit(file: string): string {
  const backupsDir = path.resolve(paths.backups());
  const snapshotPath = path.resolve(backupsDir, file);
  if (!snapshotPath.startsWith(backupsDir + path.sep)) {
    console.error(styleText('red', 'Invalid file: must be a snapshot inside the backups directory.'));
    console.error(`Backups directory: ${backupsDir}`);
    process.exit(1);
  }
  if (!existsSync(snapshotPath)) {
    console.error(styleText('red', `Snapshot not found: ${snapshotPath}`));
    console.error(`List snapshots with: ${styleText('bold', 'npx claude-mem backup list')}`);
    process.exit(1);
  }
  return snapshotPath;
}

/**
 * Direct-fs restore for when no worker is running: back up the current DB to
 * claude-mem.db.pre-restore-<ts>, copy the snapshot over it, and remove stale
 * -wal/-shm sidecars that would corrupt the restored database.
 */
function restoreDirectFs(snapshotPath: string): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (existsSync(DB_PATH)) {
    const preRestorePath = `${DB_PATH}.pre-restore-${ts}`;
    copyFileSync(DB_PATH, preRestorePath);
    console.log(`Current database backed up to: ${preRestorePath}`);
  }
  copyFileSync(snapshotPath, DB_PATH);
  for (const sidecar of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  console.log(styleText('green', `Database restored from ${path.basename(snapshotPath)}.`));
  console.log(`Start the worker with: ${styleText('bold', 'npx claude-mem start')}`);
}

export async function runRestoreCommand(argv: string[] = []): Promise<void> {
  const file = argv[0];
  if (!file) {
    printRestoreUsage();
    process.exit(1);
  }

  // Validate locally first so both paths (worker HTTP and direct-fs) refuse
  // traversal and missing files before anything is touched.
  const snapshotPath = resolveSnapshotOrExit(file);

  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const restoreUrl = `http://${workerHost}:${workerPort}/api/backup/restore`;

  let response: Response | null = null;
  try {
    response = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: path.basename(snapshotPath), confirm: true }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.log('Worker is not running — restoring directly on disk.');
      restoreDirectFs(snapshotPath);
      return;
    }
    console.error(styleText('red', `Restore failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const data = (await response.json()) as Record<string, any>;
      if (data && typeof data.error === 'string') detail = data.error;
    } catch {
      // keep generic detail
    }
    console.error(styleText('red', `Restore failed: ${detail}`));
    process.exit(1);
  }

  console.log(styleText('green', `Database restored from ${path.basename(snapshotPath)}.`));
  console.log('The worker is restarting on the restored database.');
}
