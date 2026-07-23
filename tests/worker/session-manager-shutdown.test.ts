import { describe, expect, it, mock } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('SessionManager shutdown', () => {
  it('waits for every session cleanup before reporting a failure', async () => {
    const manager = new SessionManager({} as DatabaseManager);
    (manager as any).sessions = new Map([
      [1, {}],
      [2, {}],
    ]);

    let finishSecond!: () => void;
    const secondCleanup = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const firstFailure = new Error('first cleanup failed');
    const deleteSession = mock((sessionDbId: number) =>
      sessionDbId === 1 ? Promise.reject(firstFailure) : secondCleanup
    );
    (manager as any).deleteSession = deleteSession;

    const shutdown = manager.shutdownAll();
    const earlyOutcome = await Promise.race([
      shutdown.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);

    expect(earlyOutcome).toBe('pending');
    finishSecond();
    await expect(shutdown).rejects.toBe(firstFailure);
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });
});
