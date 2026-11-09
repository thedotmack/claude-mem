import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from '../../src/services/backup/BackupManager.js';

describe('private SQLite snapshots', () => {
  it.skipIf(process.platform === 'win32')('does not widen a private source database to the usual 0644 snapshot mode', async () => {
    await verifySnapshot(0o600);
  });

  it.skipIf(process.platform === 'win32')('keeps backups private even when the source database is readable by other users', async () => {
    await verifySnapshot(0o644);
  });
});

async function verifySnapshot(sourceMode: number) {
  const dir = mkdtempSync(join(tmpdir(), 'private-snapshot-'));
  const dbPath = join(dir, 'live.db');
  const seed = new Database(dbPath);
  seed.run('CREATE TABLE memories (text TEXT)');
  seed.run("INSERT INTO memories VALUES ('private memory')");
  seed.close();
  chmodSync(dbPath, sourceMode);
  const manager = new BackupManager({}, { dbPath, backupsDir: join(dir, 'backups') });
  try {
    // Only hold this process's test umask through synchronous child creation.
    // The child inherits 022, while unrelated work keeps the original mask.
    const originalUmask = process.umask(0o022);
    let pending: ReturnType<BackupManager['createSnapshot']>;
    try { pending = manager.createSnapshot(); }
    finally { process.umask(originalUmask); }
    const snapshot = await pending;
    expect(process.umask()).toBe(originalUmask);
    expect(statSync(snapshot.path).mode & 0o777).toBe(0o600);
    expect(statSync(dbPath).mode & 0o777).toBe(sourceMode);
    const check = new Database(snapshot.path, { readonly: true });
    try {
      expect(check.query('SELECT text FROM memories').get()).toEqual({ text: 'private memory' });
      expect(check.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
