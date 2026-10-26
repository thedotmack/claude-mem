import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function makeDb(path: string, notes: string[]): void {
  const db = new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
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
  writer.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  writer.run("INSERT INTO observations (note) VALUES ('live-1'), ('live-2-wal-only')");
  const dbPath = join(dir, 'claude-mem.db');
  copyFileSync(scratch, dbPath);
  copyFileSync(`${scratch}-wal`, `${dbPath}-wal`);
  writer.close();
  return dbPath;
}

function setup(): { dir: string; dbPath: string; snapshotPath: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
  const dbPath = makeCrashedLiveDb(tempRoot);
  const snapshotPath = join(tempRoot, 'claude-mem-2026-10-01T00-00-00-000Z.db');
  makeDb(snapshotPath, ['snap-1', 'snap-2', 'snap-3']);
  return { dir: tempRoot, dbPath, snapshotPath };
}

describe('swapDatabaseFromSnapshot', () => {
  it('replaces the live database and keeps a complete pre-restore copy, WAL-only commits included', () => {
    const { dbPath, snapshotPath } = setup();

    const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snapshotPath);

    expect(readNotes(dbPath)).toEqual(['snap-1', 'snap-2', 'snap-3']);
    expect(preRestoreCopy).not.toBeNull();
    // The copy is one standalone file: no sidecar is needed to read it.
    expect(existsSync(`${preRestoreCopy!}-wal`)).toBe(false);
    expect(readNotes(preRestoreCopy!)).toEqual(['live-1', 'live-2-wal-only']);
  });

  it('leaves no stale sidecar from the old database next to the restored one', () => {
    const { dbPath, snapshotPath } = setup();

    swapDatabaseFromSnapshot(dbPath, snapshotPath);

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('keeps the old database whole and readable when the final rename fails', () => {
    const { dir, dbPath, snapshotPath } = setup();
    const failingRename = (): void => {
      throw new Error('EXDEV: injected rename failure');
    };

    expect(() => swapDatabaseFromSnapshot(dbPath, snapshotPath, { renameSync: failingRename })).toThrow('injected rename failure');

    // Every committed row of the old database is still there, and nothing
    // from the snapshot was published next to it.
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(readdirSync(dir).filter(name => name.includes('restore-staging'))).toEqual([]);
  });

  it('refuses to swap while another connection holds the live database, and touches nothing', () => {
    const { dir, dbPath, snapshotPath } = setup();
    const reader = new Database(dbPath);
    reader.run('BEGIN');
    reader.query('SELECT COUNT(*) FROM observations').get();
    try {
      expect(() => swapDatabaseFromSnapshot(dbPath, snapshotPath)).toThrow(/in use/);
    } finally {
      reader.run('COMMIT');
      reader.close();
    }
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(readdirSync(dir).filter(name => name.includes('pre-restore') || name.includes('restore-staging'))).toEqual([]);
  });

  it('rejects a snapshot that is not a valid database before touching the live one', () => {
    const { dir, dbPath } = setup();
    const corrupt = join(dir, 'claude-mem-2026-10-02T00-00-00-000Z.db');
    writeFileSync(corrupt, 'this is not sqlite');

    expect(() => swapDatabaseFromSnapshot(dbPath, corrupt)).toThrow();

    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
    expect(readdirSync(dir).filter(name => name.includes('pre-restore') || name.includes('restore-staging'))).toEqual([]);
  });

  it('throws when the snapshot is missing and leaves the live database untouched', () => {
    const { dir, dbPath } = setup();
    expect(() => swapDatabaseFromSnapshot(dbPath, join(dir, 'nope.db'))).toThrow();
    expect(readNotes(dbPath)).toEqual(['live-1', 'live-2-wal-only']);
  });

  it('restores into an empty data dir with no pre-restore copy', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
    const dbPath = join(tempRoot, 'claude-mem.db');
    const snapshotPath = join(tempRoot, 'snap.db');
    makeDb(snapshotPath, ['snap-only']);

    const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snapshotPath);

    expect(preRestoreCopy).toBeNull();
    expect(readNotes(dbPath)).toEqual(['snap-only']);
  });
});
