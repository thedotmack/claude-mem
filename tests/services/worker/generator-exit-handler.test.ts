import { describe, expect, it, mock } from 'bun:test';
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

function createDeps(pendingCount = 3) {
  const pendingStore = {
    clearPendingForSession: mock(() => undefined),
    getPendingCount: mock(() => pendingCount),
  };
  const sessionManager = {
    getPendingMessageStore: mock(() => pendingStore),
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
