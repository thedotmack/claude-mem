import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';

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
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT)');
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

  it('retains a complete raw pair if copying the recovery WAL fails before the swap', async () => {
    await fixture(async (dbPath, snapshot, backups, dir) => {
      const copy = fsPromises.copyFile;
      const rename = fs.renameSync;
      // Fail the WAL's transfer to the backup volume for either strategy.
      // SQLite has already tried opening the damaged live database by then.
      const isRecoveryWal = (from: unknown, to: unknown) => String(from).startsWith(`${dbPath}.restore-raw-`)
        && String(from).endsWith('-wal') && String(to).startsWith(`${backups}/`);
      const failure = () => Object.assign(new Error('backup volume is full'), { code: 'ENOSPC' });
      const copySpy = spyOn(fsPromises, 'copyFile').mockImplementation(async (from, to, mode) => {
        if (isRecoveryWal(from, to)) throw failure();
        return copy(from, to, mode);
      });
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (isRecoveryWal(from, to)) throw failure();
        return rename(from, to);
      });
      try {
        let caught: unknown;
        try { await swapDatabaseFromSnapshot(dbPath, snapshot, { preRestoreDir: backups }); }
        catch (error) { caught = error; }
        expect(caught instanceof Error ? caught.message : '').toContain('backup volume is full');
        expect(fs.readFileSync(dbPath).equals(damagedMain)).toBe(true);
        const raw = fs.readdirSync(dir).find(name => name.includes('.restore-raw-') && !name.endsWith('-wal'));
        expect(typeof raw).toBe('string');
        expect(fs.readFileSync(join(dir, raw!)).equals(damagedMain)).toBe(true);
        expect(fs.readFileSync(join(dir, `${raw}-wal`)).equals(damagedWal)).toBe(true);
        expect(fs.readdirSync(dir).filter(name => name.includes('restore-staging'))).toEqual([]);
      } finally { copySpy.mockRestore(); renameSpy.mockRestore(); }
    });
  });
});
