// The read side of the two backup settings keeps the bounds the settings
// write path (SettingsRoutes) enforces: settings.json is hand-editable, and
// the write path's comments state the intent ("a 1-hour floor caps that I/O
// at 24 full copies a day", "bounds disk use at 100 database copies") that
// the constructor used to bypass. The unbounded top of the interval stays
// open on purpose: backup-long-cadence pins a hand-edited monthly cadence as
// a supported scenario.
import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSnapshotNames } from '../../src/services/backup/snapshot-files.js';
import { BackupManager } from '../../src/services/backup/BackupManager.js';

/** The due date the manager arms after its first tick, i.e. now + intervalMs. */
async function firstScheduledIntervalMs(settings: { CLAUDE_MEM_BACKUP_INTERVAL_HOURS?: string }): Promise<number> {
  let now = 0;
  const manager = new BackupManager(settings, {
    now: () => now,
    initialDelayMs: 1,
    backupsDir: '/dev/null/missing',
  });
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  const run = spyOn(manager, 'runOnce').mockResolvedValue(undefined);
  try {
    manager.start();
    now = 1;
    timers.mock.calls[0]![0]();
    await Promise.resolve();
    return (manager.status().nextRunAt ?? 0) - 1;
  } finally {
    void manager.stop();
    timers.mockRestore();
  }
}

describe('BackupManager setting bounds (read side)', () => {
  it('clamps a hand-edited sub-hour interval to the 1-hour floor', async () => {
    // 0.001 hours = 3.6 s: a full VACUUM INTO copy of the database that often.
    expect(await firstScheduledIntervalMs({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '0.001' })).toBe(3_600_000);
    expect(await firstScheduledIntervalMs({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '0.5' })).toBe(3_600_000);
  });

  it('keeps legal fractional hours like 1.5 (90 minutes)', async () => {
    expect(await firstScheduledIntervalMs({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '1.5' })).toBe(5_400_000);
  });

  it('leaves long hand-edited cadences alone (monthly is a supported scenario)', async () => {
    expect(await firstScheduledIntervalMs({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '720' })).toBe(30 * 24 * 3_600_000);
  });

  it('falls back to the 24-hour default for unparseable or missing intervals', async () => {
    expect(await firstScheduledIntervalMs({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: 'abc' })).toBe(24 * 3_600_000);
    expect(await firstScheduledIntervalMs({})).toBe(24 * 3_600_000);
  });

  it('clamps a hand-edited retain count above the 100-snapshot disk bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-retain-cap-'));
    try {
      const backupsDir = join(dir, 'backups');
      mkdirSync(backupsDir, { recursive: true });
      for (let i = 0; i < 103; i++) {
        writeFileSync(join(backupsDir, `claude-mem-2026120${i % 10}T0000${String(i).padStart(2, '0')}Z.db`), '');
      }
      expect(listSnapshotNames(backupsDir)).toHaveLength(103);
      const manager = new BackupManager({ CLAUDE_MEM_BACKUP_RETAIN_COUNT: '50000' }, {
        dbPath: join(dir, 'live.db'),
        backupsDir,
        preflightDir: dir,
      });
      await manager.applyRetention();
      expect(listSnapshotNames(backupsDir)).toHaveLength(100);
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps ordinary retain counts and the empty-setting default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-retain-default-'));
    try {
      const backupsDir = join(dir, 'backups');
      mkdirSync(backupsDir, { recursive: true });
      for (let i = 0; i < 9; i++) {
        writeFileSync(join(backupsDir, `claude-mem-2026120${i % 10}T0000${String(i).padStart(2, '0')}Z.db`), '');
      }
      // No retain setting at all: the historical default of 7 applies.
      const manager = new BackupManager({}, { dbPath: join(dir, 'live.db'), backupsDir, preflightDir: dir });
      await manager.applyRetention();
      expect(listSnapshotNames(backupsDir)).toHaveLength(7);
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
