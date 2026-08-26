/**
 * `npx claude-mem restore <file>` — replace claude-mem.db from a local
 * snapshot (pro-backup plan Phase 2).
 * `npx claude-mem restore --cloud [<key>]` — download an encrypted cloud
 * backup from the sync hub, decrypt it with the local
 * CLAUDE_MEM_BACKUP_ENCRYPTION_KEY, and restore it (plan Phase 3).
 *
 * Preferred path: POST /api/backup/restore on the running worker, which
 * closes the DB cleanly, swaps the file, and self-recycles so the supervisor
 * restarts it on the restored database. When the worker is not running, a
 * direct-fs fallback performs the same swap (pre-restore copy of the current
 * DB, snapshot copied over claude-mem.db, stale -wal/-shm removed).
 */

import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { swapDatabaseFromSnapshot } from '../../services/backup/restore-swap.js';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { styleText } from 'node:util';
import { DB_PATH, USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { buildSyncAuthHeaders } from '../../services/sync/sync-auth-headers.js';
import { decryptFile } from '../../services/backup/backup-crypto.js';

function printRestoreUsage(): void {
  console.error(`Usage: npx claude-mem restore <file>`);
  console.error(`       npx claude-mem restore --cloud [<key>]`);
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
 * Direct-fs restore for when no worker is running. The staged, sidecar-aware
 * swap lives in services/backup/restore-swap.ts: fallback snapshots keep their
 * committed -wal frames, VACUUM'd snapshots get stale sidecars removed, and a
 * failed swap rolls back to the pre-restore copy.
 */
function restoreDirectFs(snapshotPath: string): void {
  const { preRestoreCopy } = swapDatabaseFromSnapshot(DB_PATH, snapshotPath);
  if (preRestoreCopy) {
    console.log(`Current database backed up to: ${preRestoreCopy}`);
  }
  console.log(styleText('green', `Database restored from ${path.basename(snapshotPath)}.`));
  console.log(`Start the worker with: ${styleText('bold', 'npx claude-mem start')}`);
}

/**
 * Shared restore path: try the running worker first (clean DB close +
 * supervisor restart), fall back to direct-fs on ECONNREFUSED. Both the
 * local and the cloud flow end here with a snapshot file on local disk.
 */
async function restoreSnapshot(snapshotPath: string): Promise<void> {
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

interface CloudBackupObject {
  key: string;
  size: number;
  uploaded: string;
}

/**
 * `restore --cloud [<key>]`: the CLI talks to the sync hub directly with the
 * settings credentials (the worker may be down — that is exactly when a
 * restore is needed). Downloads the newest (or the named) backup object,
 * decrypts it with CLAUDE_MEM_BACKUP_ENCRYPTION_KEY, then reuses the local
 * restore path above. The token is never printed or logged.
 */
async function runCloudRestore(requestedKey: string | undefined): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN;
  const userId = settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID;
  const hubUrl = settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL.trim().replace(/\/+$/, '');
  const encryptionKey = settings.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY;

  if (token === '' || userId === '' || hubUrl === '') {
    console.error(styleText('red', 'Cloud restore requires cloud-sync credentials (token, user id, hub URL) in settings.json.'));
    console.error('Connect this device at https://cmem.ai first.');
    process.exit(1);
  }
  if (encryptionKey === '') {
    console.error(styleText('red', 'CLAUDE_MEM_BACKUP_ENCRYPTION_KEY is not set in settings.json.'));
    console.error('Cloud backups are encrypted with a key that never leaves the machine that uploaded them.');
    console.error('Copy that key from the original machine\'s ~/.claude-mem/settings.json — without it the backups cannot be decrypted.');
    process.exit(1);
  }

  const headers = buildSyncAuthHeaders({
    token,
    userId,
    deviceId: settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID || undefined,
    deviceName: settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME || undefined,
  });

  let listResponse: Response;
  try {
    listResponse = await fetch(`${hubUrl}/v1/backup/list`, { headers });
  } catch (error: unknown) {
    console.error(styleText('red', `Could not reach the backup hub: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
  if (!listResponse.ok) {
    console.error(styleText('red', `Cloud backup list failed: HTTP ${listResponse.status}`));
    process.exit(1);
  }
  const listData = (await listResponse.json().catch(() => null)) as { objects?: CloudBackupObject[] } | null;
  const objects = Array.isArray(listData?.objects) ? listData.objects : [];
  if (objects.length === 0) {
    console.error(styleText('yellow', 'No cloud backups found for this account.'));
    process.exit(1);
  }

  let selected: CloudBackupObject | undefined;
  if (requestedKey) {
    selected = objects.find(object => object.key === requestedKey);
    if (!selected) {
      console.error(styleText('red', `Cloud backup not found: ${requestedKey}`));
      console.error('Available backups:');
      for (const object of objects) console.error(`  ${object.key}`);
      process.exit(1);
    }
  } else {
    selected = [...objects].sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1))[0];
  }

  console.log(`Downloading ${selected.key} …`);
  let downloadResponse: Response;
  try {
    downloadResponse = await fetch(`${hubUrl}/v1/backup/download-url?key=${encodeURIComponent(selected.key)}`, { headers });
  } catch (error: unknown) {
    console.error(styleText('red', `Download failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
  if (!downloadResponse.ok || downloadResponse.body === null) {
    console.error(styleText('red', `Download failed: HTTP ${downloadResponse.status}`));
    process.exit(1);
  }

  const backupsDir = path.resolve(paths.backups());
  mkdirSync(backupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const encPath = path.join(backupsDir, `claude-mem-cloud-${ts}.db.enc`);
  const snapshotPath = path.join(backupsDir, `claude-mem-cloud-${ts}.db`);

  try {
    // Stream to disk — cloud snapshots can be 600MB+.
    await pipeline(Readable.fromWeb(downloadResponse.body as any), createWriteStream(encPath));
    await decryptFile(encPath, snapshotPath, encryptionKey);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(styleText('red', `Decrypt failed: ${message}`));
    console.error('The download may be corrupt, or CLAUDE_MEM_BACKUP_ENCRYPTION_KEY does not match the key that encrypted this backup.');
    if (existsSync(snapshotPath)) { try { unlinkSync(snapshotPath); } catch { /* best effort */ } }
    if (existsSync(encPath)) { try { unlinkSync(encPath); } catch { /* best effort */ } }
    process.exit(1);
  }
  try { unlinkSync(encPath); } catch { /* best effort */ }

  console.log(styleText('green', `Decrypted cloud backup to ${path.basename(snapshotPath)}.`));
  await restoreSnapshot(snapshotPath);
}

export async function runRestoreCommand(argv: string[] = []): Promise<void> {
  const first = argv[0];
  if (!first) {
    printRestoreUsage();
    process.exit(1);
  }

  if (first === '--cloud') {
    await runCloudRestore(argv[1]);
    return;
  }

  // Validate locally first so both paths (worker HTTP and direct-fs) refuse
  // traversal and missing files before anything is touched.
  const snapshotPath = resolveSnapshotOrExit(first);
  await restoreSnapshot(snapshotPath);
}
