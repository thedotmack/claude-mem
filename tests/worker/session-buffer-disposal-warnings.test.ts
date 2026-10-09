import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { getSupervisor } from '../../src/supervisor/index.js';
import * as processRegistry from '../../src/supervisor/process-registry.js';
import { logger } from '../../src/utils/logger.js';

type WarnContext = {
  sessionId?: number;
  pendingCount?: number;
  pendingCountAtShutdownStart?: number;
};

let warnSpy: ReturnType<typeof spyOn>;
let reapSpy: ReturnType<typeof spyOn>;
let sdkProcessSpy: ReturnType<typeof spyOn>;
let sdkExitSpy: ReturnType<typeof spyOn>;
let spies: ReturnType<typeof spyOn>[];

function makeManager(): SessionManager {
  const dbManager = {
    getSessionById: (sessionDbId: number) => ({
      content_session_id: `content-${sessionDbId}`,
      memory_session_id: null,
      project: 'test-project',
      platform_source: 'claude',
      user_prompt: 'test prompt',
    }),
    getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
  } as unknown as DatabaseManager;
  return new SessionManager(dbManager);
}

async function enqueue(manager: SessionManager, sessionDbId: number, toolUseId: string): Promise<void> {
  await manager.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: { content: 'synthetic private input' },
    tool_response: { content: 'synthetic private response' },
    prompt_number: 1,
    toolUseId,
  });
}

function disposalContexts(): WarnContext[] {
  return warnSpy.mock.calls
    .filter(([component, , context]) => component === 'SESSION' && typeof context?.pendingCount === 'number')
    .map(([, , context]) => context);
}

function shutdownContexts(): WarnContext[] {
  return warnSpy.mock.calls
    .filter(([, , context]) => typeof context?.pendingCountAtShutdownStart === 'number')
    .map(([, , context]) => context);
}

beforeEach(() => {
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  reapSpy = spyOn(getSupervisor().getRegistry(), 'reapSession').mockResolvedValue(0);
  sdkProcessSpy = spyOn(processRegistry, 'getSdkProcessForSession').mockReturnValue(undefined);
  sdkExitSpy = spyOn(processRegistry, 'ensureSdkProcessExit').mockResolvedValue(undefined);
  spies = [
    warnSpy,
    reapSpy,
    sdkProcessSpy,
    sdkExitSpy,
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

const disposalPaths = [
  ['deleteSession', (manager: SessionManager, id: number) => manager.deleteSession(id)],
  ['removeSessionImmediate', (manager: SessionManager, id: number) => manager.removeSessionImmediate(id)],
] as const;

describe('SessionManager pending-buffer disposal warnings', () => {
  it.each(disposalPaths)('should warn with only the pending count when %s disposes buffered work', async (_, dispose) => {
    const manager = makeManager();
    await enqueue(manager, 10, 'tool-a');
    await enqueue(manager, 10, 'tool-b');
    await manager.queueSummarize(10, 'synthetic private summary');

    expect(await dispose(manager, 10)).toBeUndefined();

    expect(disposalContexts()).toEqual([{ sessionId: 10, pendingCount: 3 }]);
    expect(warnSpy.mock.calls[0][1]).toContain('pending');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('synthetic private');
    expect(manager.getMessageBuffer().getPendingCount(10)).toBe(0);
    expect(manager.getSession(10)).toBeUndefined();
    await dispose(manager, 10);
    expect(disposalContexts()).toHaveLength(1);
  });

  it.each(disposalPaths)('should stay quiet when %s disposes an empty buffer', async (_, dispose) => {
    const manager = makeManager();
    manager.initializeSession(11);

    await dispose(manager, 11);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(manager.getSession(11)).toBeUndefined();
  });

  it.each(disposalPaths)('should count claimed work but exclude confirmed and duplicate messages during %s', async (_, dispose) => {
    const manager = makeManager();
    await enqueue(manager, 12, 'tool-a');
    await enqueue(manager, 12, 'tool-b');
    await enqueue(manager, 12, 'tool-c');
    const iterator = manager.getMessageIterator(12);
    try {
      await iterator.next();
      expect(await manager.confirmClaimedMessages(12)).toBe(1);
      await iterator.next();
      await enqueue(manager, 12, 'tool-b');
      expect(manager.getMessageBuffer().getPendingCount(12)).toBe(2);

      await dispose(manager, 12);

      expect(disposalContexts()).toEqual([{ sessionId: 12, pendingCount: 2 }]);
    } finally {
      await iterator.return(undefined);
    }
  });

  it('should stay quiet for missing sessions and an empty shutdown', async () => {
    const manager = makeManager();
    await manager.deleteSession(99);
    manager.removeSessionImmediate(99);
    manager.initializeSession(13);

    await manager.shutdownAll();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(manager.getActiveSessionCount()).toBe(0);
  });

  it('should report the shutdown-start total once and count each buffer at its actual disposal', async () => {
    const manager = makeManager();
    for (const id of ['a', 'b']) await enqueue(manager, 20, `tool-${id}`);
    for (const id of ['a', 'b', 'c']) await enqueue(manager, 21, `tool-${id}`);
    manager.initializeSession(22);
    const iterator = manager.getMessageIterator(21);
    await iterator.next();
    const releaseReaps = new Map<number, (count: number) => void>();
    reapSpy.mockImplementation((id: number) => new Promise<number>(resolve => {
      releaseReaps.set(id, resolve);
    }));
    const shutdown = manager.shutdownAll();
    try {
      expect(shutdownContexts()).toEqual([{ pendingCountAtShutdownStart: 5 }]);
      expect(releaseReaps.size).toBe(3);
      manager.removeSessionImmediate(20);
      expect(await manager.confirmClaimedMessages(21)).toBe(1);
      await enqueue(manager, 21, 'tool-d');
      await enqueue(manager, 21, 'tool-e');
      for (const release of releaseReaps.values()) release(0);
      await shutdown;

      expect(disposalContexts().sort((a, b) => a.sessionId! - b.sessionId!)).toEqual([
        { sessionId: 20, pendingCount: 2 },
        { sessionId: 21, pendingCount: 4 },
      ]);
      expect(shutdownContexts()).toHaveLength(1);
      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      for (const release of releaseReaps.values()) release(0);
      await shutdown;
      await iterator.return(undefined);
    }
  });

  it('should preserve non-blocking reap errors while warning about discarded messages', async () => {
    const manager = makeManager();
    await enqueue(manager, 30, 'tool-a');
    const error = new Error('synthetic reap failure');
    reapSpy.mockRejectedValueOnce(error);

    await expect(manager.deleteSession(30)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('SESSION', 'Supervisor reapSession failed (non-blocking)', { sessionId: 30 }, error);
    expect(disposalContexts()).toEqual([{ sessionId: 30, pendingCount: 1 }]);
    expect(manager.getSession(30)).toBeUndefined();
  });

  it('should preserve an SDK cleanup failure without reporting a buffer disposal', async () => {
    const manager = makeManager();
    await enqueue(manager, 31, 'tool-a');
    const tracked = {
      process: { exitCode: null },
      pid: 999_999,
      pgid: 999_999,
    } as unknown as ReturnType<typeof processRegistry.getSdkProcessForSession>;
    sdkProcessSpy.mockReturnValueOnce(tracked);
    const error = new Error('synthetic SDK cleanup failure');
    sdkExitSpy.mockRejectedValueOnce(error);

    await expect(manager.deleteSession(31)).rejects.toBe(error);

    expect(sdkExitSpy).toHaveBeenCalledWith(tracked, 5000);
    expect(reapSpy).not.toHaveBeenCalled();
    expect(disposalContexts()).toEqual([]);
    expect(manager.getMessageBuffer().getPendingCount(31)).toBe(1);
    expect(manager.getSession(31)).toBeDefined();
  });
});
