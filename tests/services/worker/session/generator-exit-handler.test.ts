import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';
import { handleGeneratorExit } from '../../../../src/services/worker/session/GeneratorExitHandler.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

/**
 * #2756 — direct unit coverage of handleGeneratorExit's reason-branching.
 * getSdkProcessForSession (imported from the REAL process-registry.js, not
 * mocked) naturally returns undefined for these fake sessionDbIds — nothing
 * is ever registered under them in the shared singleton — so
 * ensureSdkProcessExit is skipped exactly like a generator that never
 * spawned a subprocess (the parked-in-waitForSlot case this exists for).
 */

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

function makeSession(sessionDbId: number): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: Promise.resolve(), // pre-exit placeholder; handleGeneratorExit always nulls it
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [1, 2, 3],
    conversationHistory: [{ role: 'user', content: 'hi' }],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function makeDeps() {
  const messageBuffer = { getPendingCount: mock(() => 2) };
  const sessionManager = {
    getMessageBuffer: mock(() => messageBuffer),
    removeSessionImmediate: mock(() => {}),
  };
  const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
  return { sessionManager, completionHandler, messageBuffer };
}

describe('handleGeneratorExit reason branching (#2756)', () => {
  it('quota: skips finalize/removeSessionImmediate, preserving the buffered queue', async () => {
    const session = makeSession(910001);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, 'quota:rate limited until 14:00', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
  });

  it('provider_switch: behaves exactly like quota — skips finalize/removeSessionImmediate (#2756 requirement: preserve queue/conversationHistory across a switch)', async () => {
    const session = makeSession(910002);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, 'provider_switch', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
  });

  it('any other reason (e.g. idle) still finalizes and removes the session, unlike quota/provider_switch', async () => {
    const session = makeSession(910003);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, 'idle', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
    expect(completionHandler.finalizeSession).toHaveBeenCalledTimes(1);
    expect(completionHandler.finalizeSession).toHaveBeenCalledWith(910003);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(910003);
  });

  it('a null reason (normal exit) still finalizes and removes the session', async () => {
    const session = makeSession(910004);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, null, {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(completionHandler.finalizeSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
  });

  it('finalizeSession throwing still removes the session in-memory (error path unchanged for a non-preserved reason)', async () => {
    const session = makeSession(910005);
    const { sessionManager, completionHandler } = makeDeps();
    (completionHandler.finalizeSession as ReturnType<typeof mock>).mockImplementation(() => Promise.reject(new Error('boom')));

    await handleGeneratorExit(session, 'shutdown', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(sessionManager.removeSessionImmediate).toHaveBeenCalledTimes(1);
  });
});
