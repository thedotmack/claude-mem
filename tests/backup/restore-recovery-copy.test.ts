import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { BackupManager } from '../../src/services/backup/BackupManager.js';
import { listSnapshotNames } from '../../src/services/backup/snapshot-files.js';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';
import { RESTORE_FIXTURE_SCHEMA } from './fixtures/restore-schema.js';

const damagedMain = Buffer.from('damaged database bytes worth recovering');
const damagedWal = Buffer.from('uncheckpointed WAL frames worth recovering');

async function fixture(run: (dbPath: string, snapshot: string, backups: string, dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(join(tmpdir(), 'restore-recovery-copy-'));
  const backups = join(dir, 'backups');
  fs.mkdirSync(backups);
  const dbPath = join(dir, 'claude-mem.db');
  fs.writeFileSync(dbPath, damagedMain);
  fs.writeFileSync(`${dbPath}-wal`, damagedWal);
  const snapshot = join(backups, 'claude-mem-2026-10-01T00-00-00-000Z.db');
  const db = new Database(snapshot);
  db.exec(RESTORE_FIXTURE_SCHEMA);
  db.run("INSERT INTO observations VALUES (1, 'restored')");
  db.close();
  try { await run(dbPath, snapshot, backups, dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('damaged live database recovery copy', () => {
  it('can keep the raw database and WAL on a backup filesystem that forbids cross-device rename', async () => {
    await fixture(async (dbPath, snapshot, backups, dir) => {
      const rename = fs.renameSync;
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        if (String(from).startsWith(`${dbPath}.restore-raw-`) && String(to).startsWith(`${backups}/`)) {
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
        }
        return rename(from, to);
      });
      try {
        const result = await swapDatabaseFromSnapshot(dbPath, snapshot, { preRestoreDir: backups });
        expect(result.preRestoreCopy).not.toBeNull();
        expect(fs.readFileSync(result.preRestoreCopy!).equals(damagedMain)).toBe(true);
        expect(fs.readFileSync(`${result.preRestoreCopy}-wal`).equals(damagedWal)).toBe(true);
        const restored = new Database(dbPath);
        try { expect(restored.query('SELECT note FROM observations').get()).toEqual({ note: 'restored' }); }
        finally { restored.close(); }
        expect(fs.readdirSync(dir).filter(name => name.includes('restore-raw'))).toEqual([]);
      } finally { renameSpy.mockRestore(); }
    });
  });

  it.each(['WAL copy', 'main file publication'] as const)('keeps a failed %s out of listing and retention and preserves the raw pair', async (failurePoint) => {
    await fixture(async (dbPath, snapshot, backups, dir) => {
      const copy = fsPromises.copyFile;
      const rename = fs.renameSync;
      let listedDuringWalCopy: string[] | undefined;
      const failure = () => Object.assign(new Error('backup volume is full'), { code: 'ENOSPC' });
      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to, mode) => {
        if (String(from).endsWith('-wal') && String(to).startsWith(`${backups}${sep}`)) {
          listedDuringWalCopy = listSnapshotNames(backups);
          if (failurePoint === 'WAL copy') {
            fs.writeFileSync(to, 'partial WAL');
            throw failure();
          }
        }
        return copy(from, to, mode);
      });
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (failurePoint === 'main file publication' && String(to).endsWith('-pre-restore.db')) throw failure();
        return rename(from, to);
      });
      try {
        await expect(swapDatabaseFromSnapshot(dbPath, snapshot, { preRestoreDir: backups }))
          .rejects.toThrow('backup volume is full');
        expect(listedDuringWalCopy).toEqual([basename(snapshot)]);
        expect(fs.readdirSync(backups).sort()).toEqual(['.restore-staging.lock', basename(snapshot)]);
        const manager = new BackupManager({ CLAUDE_MEM_BACKUP_RETAIN_COUNT: '1' }, { backupsDir: backups });
        await manager.applyRetention();
        expect(listSnapshotNames(backups)).toEqual([basename(snapshot)]);
        expect(fs.readFileSync(dbPath).equals(damagedMain)).toBe(true);
        const raw = fs.readdirSync(dir).find(name => name.includes('.restore-raw-') && !name.endsWith('-wal'));
        expect(typeof raw).toBe('string');
        expect(fs.readFileSync(join(dir, raw!)).equals(damagedMain)).toBe(true);
        expect(fs.readFileSync(join(dir, `${raw}-wal`)).equals(damagedWal)).toBe(true);
        expect(fs.readdirSync(dir).filter(name => name.includes('restore-staging'))).toEqual([]);
      } finally { copySpy.mockRestore(); renameSpy.mockRestore(); }
    });
  });

  it('preserves a published recovery pair if the clock repeats its timestamp', async () => {
    await fixture(async (dbPath, snapshot, backups) => {
      const existing = join(backups, 'claude-mem-2026-10-02T00-00-00-000Z-pre-restore.db');
      fs.copyFileSync(snapshot, existing);
      const original = fs.readFileSync(existing);
      fs.writeFileSync(`${existing}-wal`, 'earlier WAL');
      const clock = spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-02T00:00:00.000Z');
      try {
        await expect(swapDatabaseFromSnapshot(dbPath, snapshot, { preRestoreDir: backups }))
          .rejects.toThrow('Pre-restore copy already exists');
        expect(fs.readFileSync(existing)).toEqual(original);
        expect(fs.readFileSync(`${existing}-wal`, 'utf8')).toBe('earlier WAL');
        expect(fs.readFileSync(dbPath)).toEqual(damagedMain);
      } finally { clock.mockRestore(); }
    });
  });

  it('reclaims interrupted copies before checking free space and preserves a published WAL', async () => {
    await fixture(async (_dbPath, snapshot, backups) => {
      const abandoned = join(backups, 'claude-mem-2026-10-02T00-00-00-000Z-pre-restore.db');
      const mainOnly = join(backups, 'claude-mem-2026-10-03T00-00-00-000Z-pre-restore.db');
      const published = join(backups, 'claude-mem-2026-10-04T00-00-00-000Z-pre-restore.db');
      for (const name of [abandoned, mainOnly, published]) fs.writeFileSync(`${name}.partial`, damagedMain);
      fs.writeFileSync(`${abandoned}-wal`, damagedWal);
      fs.writeFileSync(published, damagedMain);
      fs.writeFileSync(`${published}-wal`, damagedWal);
      const unrelated = join(backups, 'import-pre-restore.db.partial');
      fs.writeFileSync(unrelated, 'unrelated');
      const statfs = fs.statfsSync;
      const space = spyOn(fs, 'statfsSync').mockImplementation((...args) => {
        const stats = statfs(...args);
        // The next backup only fits once the abandoned pair is gone.
        if (fs.existsSync(`${abandoned}.partial`) || fs.existsSync(`${abandoned}-wal`)) stats.bavail = 0;
        return stats;
      });
      try {
        const manager = new BackupManager({}, { backupsDir: backups, dbPath: snapshot });
        await manager.createSnapshot();
        for (const name of [abandoned, mainOnly, published]) expect(fs.existsSync(`${name}.partial`)).toBe(false);
        expect(fs.existsSync(`${abandoned}-wal`)).toBe(false);
        expect(fs.readFileSync(published)).toEqual(damagedMain);
        expect(fs.readFileSync(`${published}-wal`)).toEqual(damagedWal);
        expect(fs.readFileSync(unrelated, 'utf8')).toBe('unrelated');
      } finally { space.mockRestore(); }
    });
  });

  it('keeps the staging claim and WAL while a different worker runs a backup', async () => {
    await fixture(async (dbPath, snapshot, backups) => {
      const copy = fsPromises.copyFile;
      let backupRan = false;
      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to, mode) => {
        await copy(from, to, mode);
        if (!String(to).endsWith('-pre-restore.db-wal')) return;
        const managerModule = new URL('../../src/services/backup/BackupManager.ts', import.meta.url).href;
        const otherWorker = Bun.spawnSync([process.execPath, '-e', `
          import { BackupManager } from ${JSON.stringify(managerModule)};
          await new BackupManager({}, { dbPath: process.argv[1], backupsDir: process.argv[2] }).createSnapshot();
        `, snapshot, backups]);
        expect(otherWorker.exitCode).toBe(0);
        backupRan = true;
      });
      try {
        const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshot, { preRestoreDir: backups });
        expect(backupRan).toBe(true);
        expect(fs.readFileSync(preRestoreCopy!)).toEqual(damagedMain);
        expect(fs.readFileSync(`${preRestoreCopy}-wal`)).toEqual(damagedWal);
      } finally { copySpy.mockRestore(); }
    });
  });
});
