import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { swapDatabaseFromSnapshot, applyPendingRestore } from '../../src/services/backup/restore-swap.js';
import { readLastRestoreResult, stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { ChromaSyncState } from '../../src/services/sync/ChromaSyncState.js';
import { paths } from '../../src/shared/paths.js';

function makeDb(path: string, note: string) {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)');
    db.prepare('INSERT INTO observations (note) VALUES (?)').run(note);
  } finally { db.close(); }
}

function noteAt(path: string): string {
  const db = new Database(path, { readonly: true });
  try { return (db.prepare('SELECT note FROM observations').get() as any).note; }
  finally { db.close(); }
}

function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'claude-mem-restore-cleanup-'));
  const backupsDir = join(directory, 'backups');
  fs.mkdirSync(backupsDir);
  const dbPath = join(directory, 'live.db');
  const snapshotName = 'claude-mem-2026-10-01T00-00-00-000Z.db';
  const snapshotPath = join(backupsDir, snapshotName);
  makeDb(dbPath, 'live');
  makeDb(snapshotPath, 'restored');
  const exists = fs.existsSync;
  const unlink = fs.unlinkSync;
  let injected = false;
  let blockedPath = '';
  // Materialize a leftover sidecar at the sidecar-move boundary, without
  // holding the database open (which would make rename fail on Windows).
  const existsSpy = spyOn(fs, 'existsSync').mockImplementation((path: any) => {
    if (String(path) === `${dbPath}-shm` && !injected) {
      injected = true;
      fs.writeFileSync(path, 'old shared-memory sidecar');
    }
    return exists(path);
  });
  const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((path: any) => {
    if (String(path).includes('.restore-staging-') && String(path).endsWith('.live-shm')) {
      blockedPath = String(path);
      throw Object.assign(new Error('EACCES: parked sidecar is temporarily in use'), { code: 'EACCES' });
    }
    return unlink(path);
  });
  return {
    dbPath, snapshotPath, backupsDir, snapshotName,
    blockedPath: () => blockedPath,
    cleanup() {
      existsSpy.mockRestore();
      unlinkSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('restore after the database swap commits', () => {
  it('returns the committed result when deleting a parked old sidecar fails', async () => {
    const fixture = setup();
    try {
      let result: { preRestoreCopy: string | null } | undefined;
      let failure: unknown;
      try {
        result = await swapDatabaseFromSnapshot(fixture.dbPath, fixture.snapshotPath, { preRestoreDir: fixture.backupsDir });
      } catch (error) { failure = error; }
      // Even on the old code the rename has committed at this point.
      expect(noteAt(fixture.dbPath)).toBe('restored');
      expect(fixture.blockedPath().length).toBeGreaterThan(0);
      expect(failure).toBeUndefined();
      expect(noteAt(result!.preRestoreCopy!)).toBe('live');
      expect(fs.existsSync(fixture.blockedPath())).toBe(true);
      expect(fs.existsSync(`${fixture.dbPath}-shm`)).toBe(false);
    } finally { fixture.cleanup(); }
  });

  it('records a successful staged restore and still invalidates the semantic index', async () => {
    const fixture = setup();
    const project = 'committed-restore-cleanup-regression';
    try {
      ChromaSyncState.resetCacheForTests();
      ChromaSyncState.replace(project, { observations: 40, summaries: 4, prompts: 9 });
      stagePendingRestore(fixture.snapshotName);
      const result = await applyPendingRestore(fixture.dbPath, fixture.backupsDir);
      expect(noteAt(fixture.dbPath)).toBe('restored');
      expect(fixture.blockedPath().length).toBeGreaterThan(0);
      expect(result?.ok).toBe(true);
      expect(result?.error).toBeNull();
      expect(readLastRestoreResult()).toEqual(result);
      ChromaSyncState.resetCacheForTests();
      expect(ChromaSyncState.isRebuildPending(project)).toBe(true);
    } finally {
      fixture.cleanup();
      for (const path of [paths.pendingRestore(), paths.lastRestore()]) fs.rmSync(path, { force: true });
      ChromaSyncState.resetCacheForTests();
    }
  });
});
