/**
 * `npx claude-mem backup [run|status|list]` — local DB snapshots
 * (pro-backup plan Phase 2). Thin client over the worker's /api/backup/*
 * endpoints; the worker owns the snapshot engine (BackupManager).
 */

import { styleText } from 'node:util';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { BACKUP_ADDON_PITCH, backupAddonUrl } from '../../shared/pro-promo.js';

function printBackupUsage(): void {
  console.error(`Usage: npx claude-mem backup [run|status|list]`);
}

function workerBaseUrl(): string {
  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  return `http://${workerHost}:${workerPort}`;
}

/**
 * Fetch a worker /api/backup/* endpoint, exiting with the standard
 * "Worker is not running." message on ECONNREFUSED (runtime.ts pattern).
 */
export async function fetchWorkerBackupApi(pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${workerBaseUrl()}${pathname}`, init);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(styleText('red', 'Worker is not running.'));
      console.error(`Start it with: ${styleText('bold', 'npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `Backup request failed: ${message}`));
    process.exit(1);
  }
}

async function readJsonOrExit(response: Response, label: string): Promise<Record<string, any>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(styleText('red', `${label} failed: invalid JSON response (${message})`));
    process.exit(1);
  }
  if (typeof data !== 'object' || data === null) {
    console.error(styleText('red', `${label} failed: unexpected response`));
    process.exit(1);
  }
  return data as Record<string, any>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTimestamp(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'never';
}

async function runBackupStatus(): Promise<void> {
  const response = await fetchWorkerBackupApi('/api/backup/status');
  if (!response.ok) {
    console.error(styleText('red', `Backup status failed: HTTP ${response.status}`));
    process.exit(1);
  }
  const status = await readJsonOrExit(response, 'Backup status');

  if (status.configured === false) {
    console.log(styleText('yellow', 'Backups are not enabled.'));
    console.log(`Enable them by setting ${styleText('bold', 'CLAUDE_MEM_BACKUP_ENABLED')} to "true" in ~/.claude-mem/settings.json and restarting the worker.`);
    return;
  }

  console.log(styleText('bold', '\nclaude-mem backup status\n'));
  console.log(`  Last snapshot:   ${formatTimestamp(status.lastSnapshotAt)}`);
  console.log(`  Snapshot size:   ${typeof status.lastSnapshotBytes === 'number' ? formatBytes(status.lastSnapshotBytes) : 'n/a'}`);
  console.log(`  Snapshots kept:  ${status.snapshotCount ?? 0}`);
  console.log(`  Next run:        ${formatTimestamp(status.nextRunAt)}`);
  if (status.lastError) {
    console.log(`  Last error:      ${styleText('red', String(status.lastError))}`);
  }
  if (status.addonRequired === true) {
    console.log('');
    console.log(styleText('yellow', BACKUP_ADDON_PITCH));
    console.log(`  ${styleText('bold', backupAddonUrl('status'))}`);
  }
}

async function runBackupRun(): Promise<void> {
  const response = await fetchWorkerBackupApi('/api/backup/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await readJsonOrExit(response, 'Backup run');

  if (response.status === 409) {
    console.log(styleText('yellow', 'A snapshot is already running.'));
    return;
  }
  if (!response.ok) {
    console.error(styleText('red', `Backup run failed: ${data.error ?? `HTTP ${response.status}`}`));
    process.exit(1);
  }

  const snapshot = data.snapshot ?? {};
  console.log(styleText('green', 'Snapshot created.'));
  console.log(`  ${styleText('bold', 'Path:')}  ${snapshot.path}`);
  console.log(`  ${styleText('bold', 'Size:')}  ${typeof snapshot.bytes === 'number' ? formatBytes(snapshot.bytes) : 'n/a'}`);
}

async function runBackupList(): Promise<void> {
  const response = await fetchWorkerBackupApi('/api/backup/list');
  if (!response.ok) {
    console.error(styleText('red', `Backup list failed: HTTP ${response.status}`));
    process.exit(1);
  }
  const data = await readJsonOrExit(response, 'Backup list');
  const snapshots: Array<{ name: string; bytes: number; mtime: number }> = Array.isArray(data.snapshots) ? data.snapshots : [];

  if (snapshots.length === 0) {
    console.log('No snapshots yet.');
    console.log(`Create one with: ${styleText('bold', 'npx claude-mem backup run')}`);
    return;
  }

  console.log(styleText('bold', `\nSnapshots in ${data.backupsDir}\n`));
  for (const snapshot of snapshots) {
    console.log(`  ${snapshot.name}  ${styleText('dim', `${formatBytes(snapshot.bytes)}  ${formatTimestamp(snapshot.mtime)}`)}`);
  }
  console.log(`\nRestore one with: ${styleText('bold', 'npx claude-mem restore <file>')}`);
}

export async function runBackupCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase() ?? 'status';

  switch (subCommand) {
    case 'status':
      await runBackupStatus();
      break;
    case 'run':
      await runBackupRun();
      break;
    case 'list':
      await runBackupList();
      break;
    default:
      console.error(styleText('red', `Unknown backup subcommand: ${subCommand}`));
      printBackupUsage();
      process.exit(1);
  }
}
