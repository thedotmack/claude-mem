import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { BackupManager, type BackupRunResult } from '../../src/services/backup/BackupManager.js';
import { clearPendingRestore, stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { BackupRoutes } from '../../src/services/worker/http/routes/BackupRoutes.js';

async function withBackups(retain: number, run: (h: {
  snapshot: (time: string, note: string) => Promise<BackupRunResult>;
  list: () => Promise<string[]>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'backup-clock-'));
  const dbPath = join(dir, 'live.db');
  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE observations (note TEXT NOT NULL)');
  db.run("INSERT INTO observations VALUES ('initial')");
  let now = Date.parse('2026-12-01T00:00:00Z');
  const backupsDir = join(dir, 'backups');
  const manager = new BackupManager({ CLAUDE_MEM_BACKUP_RETAIN_COUNT: String(retain) }, {
    dbPath, backupsDir, preflightDir: dir, now: () => now,
  });
  const app = express();
  const routes = new BackupRoutes({ getBackupManager: () => manager } as DatabaseManager, {
    backupsDir, lastRestorePath: join(dir, 'last-restore.json'),
  });
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({
      snapshot: async (time, note) => {
        now = Date.parse(time);
        db.query('UPDATE observations SET note = ?').run(note);
        const response = await fetch(url + '/api/backup/run', { method: 'POST' });
        expect(response.status).toBe(200);
        const body = await response.json() as { success: boolean; snapshot: BackupRunResult };
        expect(body.success).toBe(true);
        expect(body.snapshot.retentionError).toBeUndefined();
        return body.snapshot;
      },
      list: async () => {
        const response = await fetch(url + '/api/backup/list');
        expect(response.status).toBe(200);
        const body = await response.json() as { snapshots: Array<{ name: string }> };
        return body.snapshots.map(row => row.name);
      },
    });
  } finally {
    await manager.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkSnapshot(snapshot: BackupRunResult, note: string): void {
  expect(existsSync(snapshot.path)).toBe(true);
  const db = new Database(snapshot.path, { readonly: true, create: false });
  try {
    expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.query('SELECT note FROM observations').get()).toEqual({ note });
  } finally { db.close(); }
}

test('a successful backup HTTP response keeps the newly written data after the clock moves backward', async () => {
  await withBackups(1, async h => {
    const before = await h.snapshot('2026-12-01T00:00:00Z', 'before correction');
    const after = await h.snapshot('2026-11-17T00:00:00Z', 'new work after correction');
    checkSnapshot(after, 'new work after correction');
    expect(await h.list()).toEqual([basename(after.path)]);
    expect(existsSync(before.path)).toBe(false);
  });
});

test('repeated corrected-clock backups stay readable within the configured retention count', async () => {
  await withBackups(3, async h => {
    for (const day of [1, 2, 3]) await h.snapshot(`2026-12-0${day}T00:00:00Z`, `old ${day}`);
    for (const day of [17, 18]) {
      const fresh = await h.snapshot(`2026-11-${day}T00:00:00Z`, `fresh ${day}`);
      checkSnapshot(fresh, `fresh ${day}`);
      const names = await h.list();
      expect(names).toHaveLength(3);
      expect(names).toContain(basename(fresh.path));
    }
  });
});

test('a pending restore remains protected alongside the new corrected-clock backup', async () => {
  await withBackups(1, async h => {
    const selected = await h.snapshot('2026-12-01T00:00:00Z', 'selected restore point');
    stagePendingRestore(basename(selected.path));
    try {
      const fresh = await h.snapshot('2026-11-17T00:00:00Z', 'new work');
      checkSnapshot(fresh, 'new work');
      checkSnapshot(selected, 'selected restore point');
      expect((await h.list()).sort()).toEqual([basename(selected.path), basename(fresh.path)].sort());
    } finally { clearPendingRestore(); }
  });
});

test('forward-clock backups still prune the oldest snapshot at the configured count', async () => {
  await withBackups(1, async h => {
    const before = await h.snapshot('2026-11-16T00:00:00Z', 'old work');
    const fresh = await h.snapshot('2026-11-17T00:00:00Z', 'new work');
    checkSnapshot(fresh, 'new work');
    expect(await h.list()).toEqual([basename(fresh.path)]);
    expect(existsSync(before.path)).toBe(false);
  });
});
