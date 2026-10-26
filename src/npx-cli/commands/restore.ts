/**
 * `npx claude-mem restore <file>`: replace claude-mem.db from a local
 * snapshot in ~/.claude-mem/backups/auto.
 *
 * The CLI never touches the database itself. It stages the restore in
 * backups/restore-pending.json and restarts the worker (the same path as
 * `npx claude-mem restart`, which also starts a worker that is not running).
 * The new worker applies the restore before it opens the database, saves the
 * current one as a `-pre-restore` snapshot, and records the outcome, which
 * `npx claude-mem backup status` prints.
 */

import { existsSync } from 'fs';
import path from 'path';
import { styleText } from 'node:util';
import { paths } from '../../shared/paths.js';
import { resolveSnapshotInside, stagePendingRestore } from '../../services/backup/snapshot-files.js';
import { runRestartCommand } from './runtime.js';

function printRestoreUsage(): void {
  console.error('Usage: npx claude-mem restore <file>');
  console.error('List snapshots with: npx claude-mem backup list');
}

export function runRestoreCommand(argv: string[] = []): void {
  const requested = argv[0];
  if (!requested) {
    printRestoreUsage();
    process.exit(1);
  }

  const backupsDir = paths.backups();
  const snapshotPath = resolveSnapshotInside(backupsDir, requested);
  if (snapshotPath === null) {
    console.error(styleText('red', 'Invalid file: give the name of a snapshot in the backups directory.'));
    console.error(`Backups directory: ${backupsDir}`);
    process.exit(1);
  }
  if (!existsSync(snapshotPath)) {
    console.error(styleText('red', `Snapshot not found: ${snapshotPath}`));
    console.error(`List snapshots with: ${styleText('bold', 'npx claude-mem backup list')}`);
    process.exit(1);
  }

  stagePendingRestore(path.basename(snapshotPath));
  console.log(`Restore of ${path.basename(snapshotPath)} staged; restarting the worker to apply it.`);
  console.log(`Then check the result with: ${styleText('bold', 'npx claude-mem backup status')}`);
  runRestartCommand();
}
