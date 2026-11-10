import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPendingRestore, swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';
import { readLastRestoreResult, stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { LATEST_SCHEMA_VERSION } from '../../src/services/sqlite/connection.js';
import { ChromaSyncState } from '../../src/services/sync/ChromaSyncState.js';
import { paths } from '../../src/shared/paths.js';

function createDatabase(file: string, value: string, schemaVersion: number) {
  const db = new Database(file);
  db.run('CREATE TABLE memories (value TEXT)');
  db.run('INSERT INTO memories VALUES (?)', [value]);
  db.run(`PRAGMA user_version = ${schemaVersion}`);
  db.close();
}

function fixture(schemaVersion: number) {
  const dir = mkdtempSync(join(tmpdir(), 'restore-schema-'));
  const dbPath = join(dir, 'live.db');
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir);
  const snapshotName = 'claude-mem-2026-01-01T00-00-00-000Z.db';
  const snapshotPath = join(backupsDir, snapshotName);
  createDatabase(dbPath, 'healthy current database', LATEST_SCHEMA_VERSION);
  createDatabase(snapshotPath, 'snapshot database', schemaVersion);
  return { dir, dbPath, backupsDir, snapshotName, snapshotPath };
}

describe('restore schema compatibility before live changes', () => {
  it('rejects a newer-schema snapshot before replacing or backing up the healthy live database', async () => {
    const { dir, dbPath, backupsDir, snapshotName, snapshotPath } = fixture(LATEST_SCHEMA_VERSION + 1);
    const originalLive = readFileSync(dbPath);
    const originalSnapshot = readFileSync(snapshotPath);
    try {
      let failure: unknown;
      try { await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir }); }
      catch (error) { failure = error; }
      expect(failure instanceof Error).toBe(true);
      expect((failure as Error).message).toContain(`schema v${LATEST_SCHEMA_VERSION + 1}`);
      expect(readFileSync(dbPath)).toEqual(originalLive);
      expect(readFileSync(snapshotPath)).toEqual(originalSnapshot);
      expect(readdirSync(backupsDir)).toEqual([snapshotName]);
      expect(readdirSync(dir).filter(name => name.includes('.restore-'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records a failed pending restore and leaves the worker able to use its existing database', async () => {
    const { dir, dbPath, backupsDir, snapshotName } = fixture(LATEST_SCHEMA_VERSION + 1);
    const pendingFile = join(dir, 'restore-pending.json');
    const resultFile = join(dir, 'last-restore.json');
    const pendingSpy = spyOn(paths, 'pendingRestore').mockReturnValue(pendingFile);
    const resultSpy = spyOn(paths, 'lastRestore').mockReturnValue(resultFile);
    let semanticRebuilds = 0;
    const rebuildSpy = spyOn(ChromaSyncState, 'markAllForRebuild').mockImplementation(() => { semanticRebuilds++; });
    try {
      stagePendingRestore(snapshotName);
      const result = await applyPendingRestore(dbPath, backupsDir);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain(`schema v${LATEST_SCHEMA_VERSION + 1}`);
      expect(result?.preRestoreCopy).toBeNull();
      expect(readLastRestoreResult()).toEqual(result);
      expect(existsSync(pendingFile)).toBe(false);
      expect(semanticRebuilds).toBe(0);
      const db = new Database(dbPath);
      try {
        expect(db.query('SELECT value FROM memories').get()).toEqual({ value: 'healthy current database' });
        expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
      } finally { db.close(); }
    } finally {
      rebuildSpy.mockRestore(); resultSpy.mockRestore(); pendingSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('also refuses a newer schema stamp committed only in a snapshot WAL', async () => {
    const { dir, dbPath, backupsDir, snapshotPath } = fixture(LATEST_SCHEMA_VERSION);
    const writer = new Database(snapshotPath);
    try {
      writer.run('PRAGMA journal_mode = WAL');
      writer.run('PRAGMA wal_autocheckpoint = 0');
      writer.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
      // The main file alone still has the compatible stamp; the restore must
      // validate the actual staged main + WAL state that it would install.
      const mainOnly = join(dir, 'main-only.db');
      copyFileSync(snapshotPath, mainOnly);
      const probe = new Database(mainOnly);
      try { expect(probe.query('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION }); }
      finally { probe.close(); }
      const originalLive = readFileSync(dbPath);
      let failure: unknown;
      try { await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir }); }
      catch (error) { failure = error; }
      expect(failure instanceof Error).toBe(true);
      expect((failure as Error).message).toContain(`schema v${LATEST_SCHEMA_VERSION + 1}`);
      expect(readFileSync(dbPath)).toEqual(originalLive);
    } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('continues restoring unstamped, older, and current-schema snapshots', async () => {
    for (const schemaVersion of [0, LATEST_SCHEMA_VERSION - 1, LATEST_SCHEMA_VERSION]) {
      const { dir, dbPath, backupsDir, snapshotPath } = fixture(schemaVersion);
      try {
        const result = await swapDatabaseFromSnapshot(dbPath, snapshotPath, { preRestoreDir: backupsDir });
        expect(result.preRestoreCopy).not.toBeNull();
        const db = new Database(dbPath);
        try {
          expect(db.query('SELECT value FROM memories').get()).toEqual({ value: 'snapshot database' });
          expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: schemaVersion });
          expect(db.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
        } finally { db.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});
