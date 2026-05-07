import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import { handleGeneratorExit } from '../../../src/services/worker/session/GeneratorExitHandler.js';

function createSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-42',
    memorySessionId: 'memory-42',
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'test',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: Promise.resolve(),
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function createDeps(pendingCount = 3, sessionToReturn: ActiveSession | null = null) {
  const pendingStore = {
    clearPendingForSession: mock(() => undefined),
    getPendingCount: mock(() => pendingCount),
  };
  const sessionManager = {
    getPendingMessageStore: mock(() => pendingStore),
    getSession: mock(() => sessionToReturn),
    removeSessionImmediate: mock(() => undefined),
  };
  const completionHandler = {
    finalizeSession: mock(() => undefined),
  };
  const restartGenerator = mock(() => undefined);

  return {
    pendingStore,
    sessionManager,
    completionHandler,
    restartGenerator,
    deps: {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
      restartGenerator,
    },
  };
}

afterEach(() => {
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

describe('handleGeneratorExit hard-stop reasons', () => {
  it('does not restart pending work after context overflow', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps();

    await handleGeneratorExit(session, 'overflow', deps);

    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(pendingStore.getPendingCount).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
  });

  it('does not restart pending work while quota guard is active', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps();

    await handleGeneratorExit(session, 'quota:hourly', deps);

    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(pendingStore.getPendingCount).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
  });

  it('removes hard-stopped sessions even when pending cleanup fails', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps();
    pendingStore.clearPendingForSession.mockImplementation(() => {
      throw new Error('simulated pending cleanup failure');
    });

    await handleGeneratorExit(session, 'overflow', deps);

    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(pendingStore.getPendingCount).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
  });

  it('removes hard-stopped sessions even when finalization fails', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps();
    completionHandler.finalizeSession.mockImplementation(() => {
      throw new Error('simulated finalization failure');
    });

    await handleGeneratorExit(session, 'quota', deps);

    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(pendingStore.getPendingCount).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
  });

  it('removes naturally completed sessions even when finalization fails', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(0);
    completionHandler.finalizeSession.mockImplementation(() => {
      throw new Error('simulated finalization failure');
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(restartGenerator).not.toHaveBeenCalled();
  });
});

describe('handleGeneratorExit recoverable exits', () => {
  it('restarts pending work for non-hard-stop reasons', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(2, session);

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();

    jest.advanceTimersByTime(1000);

    expect(sessionManager.getSession).toHaveBeenCalledWith(42);
    expect(restartGenerator).toHaveBeenCalledWith(session, 'pending-work-restart');
  });

  it('does not treat unknown abortReason strings as hard stops', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(1, session);

    await handleGeneratorExit(session, 'provider-rate-limit', deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);

    expect(sessionManager.getSession).toHaveBeenCalledWith(42);
    expect(restartGenerator).toHaveBeenCalledWith(session, 'pending-work-restart');
  });

  it('restarts pending work when the generator exits with no abort reason', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(1, session);

    await handleGeneratorExit(session, null, deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();

    jest.advanceTimersByTime(1000);

    expect(sessionManager.getSession).toHaveBeenCalledWith(42);
    expect(restartGenerator).toHaveBeenCalledWith(session, 'pending-work-restart');
  });
});

describe('handleGeneratorExit recovery count failures', () => {
  it('preserves pending rows when pending count fails with temporary SQLite busy/locked pressure', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(3, session);
    const busyError = Object.assign(new Error('SQLITE_BUSY: database is locked'), {
      code: 'SQLITE_BUSY',
    });
    pendingStore.getPendingCount.mockImplementation(() => {
      throw busyError;
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
    expect(restartGenerator).not.toHaveBeenCalled();
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();

    jest.advanceTimersByTime(1000);

    expect(sessionManager.getSession).toHaveBeenCalledWith(42);
    expect(restartGenerator).toHaveBeenCalledWith(session, 'pending-work-restart');
  });

  it('trips RestartGuard on repeated temporary SQLite busy count failures without clearing pending rows', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(3, session);
    const busyError = Object.assign(new Error('SQLITE_BUSY: database is locked'), {
      code: 'SQLITE_BUSY',
    });
    pendingStore.getPendingCount.mockImplementation(() => {
      throw busyError;
    });

    for (let i = 0; i < 6; i += 1) {
      await handleGeneratorExit(session, 'idle', deps);
    }

    expect(pendingStore.getPendingCount).toHaveBeenCalledTimes(6);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
    expect(restartGenerator).not.toHaveBeenCalled();
    expect(session.consecutiveRestarts).toBe(0);
    expect(session.respawnTimer).toBeUndefined();
  });

  it('keeps explicit cleanup when pending count fails with a non-temporary error', async () => {
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps();
    pendingStore.getPendingCount.mockImplementation(() => {
      throw new Error('no such table: pending_messages');
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(restartGenerator).not.toHaveBeenCalled();
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });
});

describe('handleGeneratorExit respawn timer failures', () => {
  it('catches synchronous restartGenerator throws from the timer and terminates normal pending work under RestartGuard', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(2, session);
    restartGenerator.mockImplementation(() => {
      throw new Error('simulated synchronous restart failure');
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();

    expect(restartGenerator).toHaveBeenCalledTimes(1);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    expect(() => jest.advanceTimersByTime(2000)).not.toThrow();

    expect(restartGenerator).toHaveBeenCalledTimes(2);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    expect(() => jest.advanceTimersByTime(4000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();

    expect(restartGenerator).toHaveBeenCalledTimes(5);
    expect(pendingStore.clearPendingForSession).toHaveBeenCalledWith(42);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
  });

  it('preserves pending rows when temporary SQLite respawn retries trip RestartGuard after restartGenerator throws', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(3, session);
    const busyError = Object.assign(new Error('SQLITE_LOCKED: database table is locked'), {
      code: 'SQLITE_LOCKED',
    });
    pendingStore.getPendingCount.mockImplementation(() => {
      throw busyError;
    });
    restartGenerator.mockImplementation(() => {
      throw new Error('simulated synchronous restart failure');
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(2000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(4000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();

    expect(restartGenerator).toHaveBeenCalledTimes(5);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
    expect(session.consecutiveRestarts).toBe(0);
    expect(session.respawnTimer).toBeUndefined();
  });

  it('preserves pending rows when restartGenerator hits SQLite pressure after pending count succeeds', async () => {
    jest.useFakeTimers();
    const session = createSession();
    const { deps, pendingStore, completionHandler, sessionManager, restartGenerator } = createDeps(3, session);
    const busyError = Object.assign(new Error('SQLITE_BUSY: database is busy'), {
      code: 'SQLITE_BUSY',
    });
    restartGenerator.mockImplementation(() => {
      throw busyError;
    });

    await handleGeneratorExit(session, 'idle', deps);

    expect(pendingStore.getPendingCount).toHaveBeenCalledWith(42);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(2000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(4000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();

    expect(restartGenerator).toHaveBeenCalledTimes(5);
    expect(pendingStore.clearPendingForSession).not.toHaveBeenCalled();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(42);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
    expect(session.consecutiveRestarts).toBe(0);
    expect(session.respawnTimer).toBeUndefined();
  });
});
