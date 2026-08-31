import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';

function setup(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
  const dbPath = join(dir, 'claude-mem.db');
  writeFileSync(dbPath, 'live-db');
  return { dir, dbPath };
}

function writeSnapshot(path: string, payload: string): void {
  writeFileSync(path, Buffer.concat([
    Buffer.from('SQLite format 3\0', 'ascii'),
    Buffer.from(payload),
  ]));
}

function readSnapshotPayload(path: string): string {
  return readFileSync(path).subarray(16).toString('utf-8');
}

describe('swapDatabaseFromSnapshot', () => {
  it('restores snapshot sidecars when the snapshot carries them (fallback snapshots)', () => {
    const { dir, dbPath } = setup();
    writeFileSync(`${dbPath}-wal`, 'live-wal');
    const snap = join(dir, 'snap.db');
    writeSnapshot(snap, 'snap-db');
    writeFileSync(`${snap}-wal`, 'snap-wal');
    writeFileSync(`${snap}-shm`, 'snap-shm');

    const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snap);

    expect(readSnapshotPayload(dbPath)).toBe('snap-db');
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('snap-wal');
    expect(readFileSync(`${dbPath}-shm`, 'utf8')).toBe('snap-shm');
    expect(preRestoreCopy).not.toBeNull();
    expect(readFileSync(preRestoreCopy!, 'utf8')).toBe('live-db');
    // The live WAL rides along with the pre-restore copy so a rollback keeps it.
    expect(readFileSync(`${preRestoreCopy!}-wal`, 'utf8')).toBe('live-wal');
  });

  it('removes stale destination sidecars when the snapshot has none (VACUUM snapshots)', () => {
    const { dir, dbPath } = setup();
    writeFileSync(`${dbPath}-wal`, 'stale-wal');
    writeFileSync(`${dbPath}-shm`, 'stale-shm');
    const snap = join(dir, 'snap.db');
    writeSnapshot(snap, 'snap-db');

    swapDatabaseFromSnapshot(dbPath, snap);

    expect(readSnapshotPayload(dbPath)).toBe('snap-db');
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('returns a null pre-restore copy when no live database exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-swap-test-'));
    const dbPath = join(dir, 'claude-mem.db');
    const snap = join(dir, 'snap.db');
    writeSnapshot(snap, 'snap-db');

    const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snap);

    expect(preRestoreCopy).toBeNull();
    expect(readSnapshotPayload(dbPath)).toBe('snap-db');
  });

  it('throws when the snapshot is missing and leaves the live database untouched', () => {
    const { dir, dbPath } = setup();
    expect(() => swapDatabaseFromSnapshot(dbPath, join(dir, 'nope.db'))).toThrow();
    expect(readFileSync(dbPath, 'utf8')).toBe('live-db');
  });

  it('rejects a non-SQLite snapshot before creating a safety copy or touching the live DB', () => {
    const { dir, dbPath } = setup();
    const snap = join(dir, 'snap.db');
    writeFileSync(snap, 'not a sqlite database');

    expect(() => swapDatabaseFromSnapshot(dbPath, snap)).toThrow('not a SQLite database');
    expect(readFileSync(dbPath, 'utf8')).toBe('live-db');
    expect(readdirSync(dir).some(name => name.startsWith('claude-mem.db.pre-restore-'))).toBe(false);
  });
});
