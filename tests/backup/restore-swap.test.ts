import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';
import { SNAPSHOT_FILE_PATTERN } from '../../src/services/backup/snapshot-files.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

const CREATE_TABLE = 'CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)';

function makeDb(path: string, notes: string[]): void {
  const db = new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(CREATE_TABLE);
  const insert = db.prepare('INSERT INTO observations (note) VALUES (?)');
  for (const note of notes) insert.run(note);
  insert.finalize();
  db.close();
}

/** Opened read-write, as the worker opens its database. */
function readNotes(path: string): string[] {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    return (db.query('SELECT note FROM observations ORDER BY id').all() as Array<{ note: string }>).map(row => row.note);
  } finally {
    db.close();
  }
}

/**
 * A live database whose newest commits exist only in its -wal sidecar, the
 * state a worker that died without a checkpoint leaves on disk. Built by
 * copying the db and its WAL while the writer still holds them open.
 */
function makeCrashedLiveDb(dir: string): string {
  const scratch = join(dir, 'scratch.db');
  const writer = new Database(scratch);
  writer.run('PRAGMA journal_mode = WAL');
  writer.run('PRAGMA wal_autocheckpoint = 0');
  writer.run(CREATE_TABLE);
  writer.run("INSERT INTO observations (note) VALUES ('live-1'), ('live-2-wal-only')");
  const dbPath = join(dir, 'claude-mem.db');
  copyFileSync(scratch, dbPath);
  copyFileSync(`${scratch}-wal`, `${dbPath}-wal`);
  writer.close();
  return dbPath;
}

function setup(): { dir: string; dbPath: string; snapshotPath: string; backupsDir: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
  const backupsDir = join(tempRoot, 'backups', 'auto');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = makeCrashedLiveDb(tempRoot);
  const snapshotPath = join(backupsDir, 'claude-mem-2026-10-01T00-00-00-000Z.db');
  makeDb(snapshotPath, ['snap-1']);
  return { dir: tempRoot, dbPath, snapshotPath, backupsDir };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('restore-staging'));
}

describe('swapDatabaseFromSnapshot', () => {
  it('replaces the live database and keeps a restorable pre-restore snapshot, WAL-only commits included', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();

    const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });

    expect(readNotes(dbPath)).toEqual(['snap-1']);
    expect(preRestoreCopy).not.toBeNull();
    expect(preRestoreCopy!.startsWith(backupsDir)).toBe(true);
    expect(SNAPSHOT_FILE_PATTERN.test(preRestoreCopy!.slice(backupsDir.length + 1))).toBe(true);
    expect(readNotes(preRestoreCopy!)).toEqual(['live-1', 'live-2-wal-only']);
  });

  it('leaves no stale sidecar from the old database next to the restored one', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();

    await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('never reuses an id the replaced database already handed out', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();

    await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });

    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
      db.run("INSERT INTO observations (note) VALUES ('after-restore')");
      const row = db.query("SELECT id FROM observations WHERE note = 'after-restore'").get() as { id: number };
      // The live database had used ids 1 and 2; the snapshot only 1.
      expect(row.id).toBe(3);
    } finally {
      db.close();
    }
  });

  it('keeps the old database whole and readable when the final rename fails', async () => {
    const { dir, dbPath, snapshotPath, backupsDir } = setup();
    const failingRename = (): void => {
      throw new Error('EXDEV: injected rename failure');
    };

    await expect(swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir, renameSync: failingRename }))
      .rejects.toThrow('injected rename failure');

    // Every committed row of the old database is still there, and nothing
    // from the snapshot was published next to it.
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(leftovers(dir)).toEqual([]);
  });

  it('refuses to swap while another connection holds the live database, and touches nothing', async () => {
    const { dir, dbPath, snapshotPath, backupsDir } = setup();
    const reader = new Database(dbPath);
    reader.run('BEGIN');
    reader.query('SELECT COUNT(*) FROM observations').get();
    try {
      await expect(swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir })).rejects.toThrow(/in use/);
    } finally {
      reader.run('COMMIT');
      reader.close();
    }
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(leftovers(dir)).toEqual([]);
    expect(readdirSync(backupsDir).filter(name => name.includes('pre-restore'))).toEqual([]);
  });

  it('rejects a snapshot that is not a valid database before touching the live one', async () => {
    const { dir, dbPath, backupsDir } = setup();
    const corrupt = join(backupsDir, 'claude-mem-2026-10-02T00-00-00-000Z.db');
    writeFileSync(corrupt, 'this is not sqlite');

    await expect(swapDatabaseFromSnapshot(dbPath, corrupt, { preRestoreDir: backupsDir })).rejects.toThrow();

    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(leftovers(dir)).toEqual([]);
    expect(readdirSync(backupsDir).filter(name => name.includes('pre-restore'))).toEqual([]);
  });

  it('still restores over a live database too damaged to open, and keeps it', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();
    writeFileSync(dbPath, 'damaged beyond repair');
    rmSync(`${dbPath}-wal`, { force: true });

    const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });

    expect(readNotes(dbPath)).toEqual(['snap-1']);
    expect(existsSync(preRestoreCopy!)).toBe(true);
  });

  it('keeps a damaged database and its -wal byte for byte when the rename fails', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();
    writeFileSync(dbPath, 'damaged beyond repair');
    writeFileSync(`${dbPath}-wal`, 'frames that may still matter');
    const failingRename = (): void => {
      throw new Error('EPERM: injected rename failure');
    };

    await expect(swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir, renameSync: failingRename }))
      .rejects.toThrow('injected rename failure');

    expect(readFileSync(dbPath, 'utf8')).toBe('damaged beyond repair');
    // Copied before SQLite ever opened it, so nothing it discarded is lost.
    const copy = readdirSync(backupsDir).find(name => name.endsWith('-pre-restore.db'))!;
    expect(readFileSync(join(backupsDir, copy), 'utf8')).toBe('damaged beyond repair');
    expect(readFileSync(join(backupsDir, `${copy}-wal`), 'utf8')).toBe('frames that may still matter');
  });

  it('puts the live sidecars back when the rename fails', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();
    // An idle second connection keeps the -wal and -shm on disk on every
    // platform without blocking the checkpoint.
    const idle = new Database(dbPath);
    idle.query('SELECT COUNT(*) FROM observations').get();
    let parkedAtRename: string[] = [];
    const failingRename = (): void => {
      parkedAtRename = readdirSync(join(dbPath, '..')).filter(name => name.includes('.live-'));
      throw new Error('EPERM: injected rename failure');
    };
    try {
      await expect(swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir, renameSync: failingRename }))
        .rejects.toThrow('injected rename failure');

      expect(parkedAtRename.length).toBeGreaterThan(0);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(readdirSync(join(dbPath, '..')).filter(name => name.includes('.live-'))).toEqual([]);
    } finally {
      idle.close();
    }
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
  });

  it('waits out a connection that lets go within the retry window', async () => {
    const { dbPath, snapshotPath, backupsDir } = setup();
    const reader = new Database(dbPath);
    reader.run('BEGIN');
    reader.query('SELECT COUNT(*) FROM observations').get();
    setTimeout(() => {
      reader.run('COMMIT');
      reader.close();
    }, 300);

    await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir, busyRetryWindowMs: 5_000 });

    expect(readNotes(dbPath)).toEqual(['snap-1']);
  });

  it('throws when the snapshot is missing and leaves the live database untouched', async () => {
    const { dbPath, backupsDir } = setup();
    await expect(swapDatabaseFromSnapshot(dbPath, join(backupsDir, 'nope.db'), { preRestoreDir: backupsDir })).rejects.toThrow();
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
  });

  it('restores into an empty data dir with no pre-restore copy', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
    const dbPath = join(tempRoot, 'claude-mem.db');
    const snapshotPath = join(tempRoot, 'snap.db');
    makeDb(snapshotPath, ['snap-only']);

    const { preRestoreCopy } = await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: tempRoot });

    expect(preRestoreCopy).toBeNull();
    expect(readNotes(dbPath)).toEqual(['snap-only']);
  });
});
