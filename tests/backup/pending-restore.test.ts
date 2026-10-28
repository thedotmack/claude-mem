import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyPendingRestore } from '../../src/services/backup/restore-swap.js';
import { readLastRestoreResult, resolveSnapshotInside, stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { paths } from '../../src/shared/paths.js';
import { ChromaSyncState } from '../../src/services/sync/ChromaSyncState.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  for (const file of [paths.pendingRestore(), paths.lastRestore()]) {
    if (existsSync(file)) rmSync(file);
  }
});

function makeDb(path: string, note: string): void {
  const db = new Database(path);
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  db.run('INSERT INTO observations (note) VALUES (?)', [note]);
  db.close();
}

function readNote(path: string): string {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    return (db.query('SELECT note FROM observations').get() as { note: string }).note;
  } finally {
    db.close();
  }
}

function setup(): { dbPath: string; backupsDir: string; snapshotName: string } {
  tempRoot = mkdtempSync(join(tmpdir(), 'pending-restore-test-'));
  const backupsDir = join(tempRoot, 'backups', 'auto');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = join(tempRoot, 'claude-mem.db');
  makeDb(dbPath, 'live');
  const snapshotName = 'claude-mem-2026-10-01T00-00-00-000Z.db';
  makeDb(join(backupsDir, snapshotName), 'snapshot');
  return { dbPath, backupsDir, snapshotName };
}

describe('resolveSnapshotInside', () => {
  it('accepts a snapshot name inside the backups dir', () => {
    expect(resolveSnapshotInside('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db'))
      .toBe(join('/data/backups/auto', 'claude-mem-2026-10-01T00-00-00-000Z.db'));
  });

  it('rejects traversal, absolute paths, nested paths and non-snapshot names', () => {
    expect(resolveSnapshotInside('/data/backups/auto', '../../etc/passwd')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', '/etc/claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'nested/claude-mem-x.db')).toBeNull();
    expect(resolveSnapshotInside('/data/backups/auto', 'notes.txt')).toBeNull();
  });
});

describe('applyPendingRestore', () => {
  it('does nothing when no restore is staged', async () => {
    const { dbPath, backupsDir } = setup();
    expect(await applyPendingRestore(dbPath, backupsDir)).toBeNull();
    expect(readNote(dbPath)).toBe('live');
  });

  it('applies a staged restore once, clears the marker and records the outcome', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    stagePendingRestore(snapshotName);

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(true);
    expect(readNote(dbPath)).toBe('snapshot');
    expect(readNote(result!.preRestoreCopy!)).toBe('live');
    expect(result!.preRestoreCopy!.startsWith(backupsDir)).toBe(true);
    expect(existsSync(paths.pendingRestore())).toBe(false);
    expect(readLastRestoreResult()).toEqual(result);
    // A second boot finds nothing to do.
    expect(await applyPendingRestore(dbPath, backupsDir)).toBeNull();
  });

  it('flags the semantic index for a rebuild after a successful restore', async () => {
    const { dbPath, backupsDir, snapshotName } = setup();
    ChromaSyncState.resetCacheForTests();
    ChromaSyncState.replace('restore-test-project', { observations: 40, summaries: 4, prompts: 9 });
    stagePendingRestore(snapshotName);

    await applyPendingRestore(dbPath, backupsDir);

    ChromaSyncState.resetCacheForTests();
    expect(ChromaSyncState.isRebuildPending('restore-test-project')).toBe(true);
  });

  it('records a failure, clears the marker and leaves the database unchanged', async () => {
    const { dbPath, backupsDir } = setup();
    stagePendingRestore('claude-mem-2099-01-01T00-00-00-000Z.db');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('snapshot not found');
    expect(readNote(dbPath)).toBe('live');
    expect(existsSync(paths.pendingRestore())).toBe(false);
  });

  it('refuses a marker that points outside the backups dir', async () => {
    const { dbPath, backupsDir } = setup();
    stagePendingRestore('../../claude-mem.db');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('outside the backups directory');
    expect(readNote(dbPath)).toBe('live');
  });

  it('clears and reports an unreadable marker instead of failing every boot', async () => {
    const { dbPath, backupsDir } = setup();
    mkdirSync(join(paths.pendingRestore(), '..'), { recursive: true });
    writeFileSync(paths.pendingRestore(), '{not json');

    const result = await applyPendingRestore(dbPath, backupsDir);

    expect(result?.ok).toBe(false);
    expect(existsSync(paths.pendingRestore())).toBe(false);
    expect(readNote(dbPath)).toBe('live');
  });
});
