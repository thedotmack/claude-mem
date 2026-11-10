import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackupManager } from '../../src/services/backup/BackupManager.js';
import { resolveSnapshotInside, stagePendingRestore, clearPendingRestore } from '../../src/services/backup/snapshot-files.js';

const name = (day: number) => `claude-mem-2026-11-0${day}T00-00-00-000Z.db`;

async function withManager(fn: (dir: string, manager: BackupManager) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-selection-'));
  try {
    await fn(dir, new BackupManager({ CLAUDE_MEM_BACKUP_RETAIN_COUNT: '1' }, { backupsDir: dir, dbPath: join(dir, 'live.db') }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('an older snapshot requested for restore survives the next retention cycle', async () => {
  await withManager(async (dir, manager) => {
    for (const day of [1, 2, 3]) writeFileSync(join(dir, name(day)), 'snapshot');
    stagePendingRestore(name(1));
    try {
      await manager.applyRetention();
      assert.ok(existsSync(join(dir, name(1))));
      assert.ok(!existsSync(join(dir, name(2))));
      assert.ok(existsSync(join(dir, name(3))));
    } finally { clearPendingRestore(); }
    await manager.applyRetention();
    assert.ok(!existsSync(join(dir, name(1))));
  });
});

test('a directory with a snapshot suffix cannot evict the last real backup', async () => {
  await withManager(async (dir, manager) => {
    writeFileSync(join(dir, name(1)), 'last verified snapshot');
    mkdirSync(join(dir, name(3)));
    assert.equal(manager.status().snapshotCount, 1);
    assert.equal(resolveSnapshotInside(dir, name(3)), null);
    await manager.applyRetention();
    assert.ok(existsSync(join(dir, name(1))));
  });
});
