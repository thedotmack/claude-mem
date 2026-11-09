import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BackupManager } from '../../src/services/backup/BackupManager.js';

const MiB = 1024 * 1024;

async function snapshotError(manager: BackupManager): Promise<string> {
  try { await manager.runNow(); return ''; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

describe('backup disk admission', () => {
  it('includes uncheckpointed WAL pages before starting a snapshot', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'claude-mem-backup-space-'));
    const dbPath = join(directory, 'live.db');
    const backupsDir = join(directory, 'backups');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    db.exec('CREATE TABLE memories (body BLOB); INSERT INTO memories VALUES (zeroblob(2097152))');
    // The main file is still small while more than 2 MiB live only in WAL.
    expect(fs.statSync(dbPath).size).toBeLessThan(MiB);
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(2 * MiB);
    const stats = spyOn(fs, 'statfsSync').mockReturnValue({ bsize: 1, bavail: 101 * MiB } as any);
    try {
      const manager = new BackupManager({}, { dbPath, backupsDir });
      expect(await snapshotError(manager)).toContain('Insufficient disk');
      expect(manager.status().snapshotCount).toBe(0);
      expect(manager.status().lastError).toContain('Insufficient disk');
    } finally {
      stats.mockRestore();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks the snapshot destination rather than a different source volume', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'claude-mem-backup-volume-'));
    const dbPath = join(directory, 'live.db');
    const backupsDir = join(directory, 'destination', 'backups');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE memories (body TEXT)');
    db.close();
    const probed: string[] = [];
    const stats = spyOn(fs, 'statfsSync').mockImplementation((path: any) => {
      probed.push(String(path));
      return { bsize: 1, bavail: String(path) === backupsDir ? 0 : 1024 * MiB } as any;
    });
    try {
      const manager = new BackupManager({}, { dbPath, backupsDir });
      expect(await snapshotError(manager)).toContain('Insufficient disk');
      expect(probed).toEqual([backupsDir]);
      expect(fs.existsSync(backupsDir)).toBe(true);
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally {
      stats.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains an explicit preflight location when there is no WAL sidecar', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'claude-mem-backup-override-'));
    const dbPath = join(directory, 'live.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE memories (body TEXT)');
    db.close();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    const probed: string[] = [];
    const stats = spyOn(fs, 'statfsSync').mockImplementation((path: any) => {
      probed.push(String(path));
      return { bsize: 1, bavail: 0 } as any;
    });
    try {
      const manager = new BackupManager({}, { dbPath, backupsDir: join(directory, 'backups'), preflightDir: directory });
      expect(await snapshotError(manager)).toContain('Insufficient disk');
      expect(probed).toEqual([directory]);
    } finally {
      stats.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
