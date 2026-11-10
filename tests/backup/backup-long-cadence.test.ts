import { expect, it, spyOn } from 'bun:test';
import { BackupManager } from '../../src/services/backup/BackupManager.js';

it('keeps a monthly backup due date while waiting in timer-sized steps', async () => {
  const maxDelay = 2_147_483_647;
  const interval = 30 * 24 * 60 * 60 * 1000;
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  let now = 0;
  const manager = new BackupManager({ CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '720' }, {
    now: () => now,
    initialDelayMs: 1,
    backupsDir: '/dev/null/missing',
  });
  const run = spyOn(manager, 'runOnce').mockResolvedValue(undefined);
  try {
    manager.start();
    now = 1;
    timers.mock.calls[0]![0]();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.status().nextRunAt).toBe(1 + interval);
    expect(timers.mock.calls[1]![1]).toBe(maxDelay);

    now += maxDelay;
    timers.mock.calls[1]![0]();
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.status().nextRunAt).toBe(1 + interval);
    expect(timers.mock.calls[2]![1]).toBe(interval - maxDelay);

    now = 1 + interval;
    timers.mock.calls[2]![0]();
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    await manager.stop();
    timers.mockRestore();
  }
});
