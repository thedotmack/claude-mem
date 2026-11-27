import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';
import { handleGeneratorExit } from '../../../../src/services/worker/session/GeneratorExitHandler.js';
import { abortCategoryOf } from '../../../../src/services/worker/session/abort-reason.js';
import { OpenAICompatProvider } from '../../../../src/services/worker/OpenAICompatProvider.js';
import { ClassifiedProviderError, HOST_MODEL_NOT_SERVED_CODE, OWN_MODEL_NOT_SERVED_CODE } from '../../../../src/services/worker/provider-errors.js';
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
    clearPendingForSession: mock(async () => 2),
    discardBufferedWork: mock(() => 2),
  };
  const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
  return { sessionManager, completionHandler, messageBuffer };
}

describe('handleGeneratorExit reason branching (#2756)', () => {
  it('quota: keeps session identity but discards the pending inputs', async () => {
    const session = makeSession(910001);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, 'quota:rate limited until 14:00', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
    // discardBufferedWork also resets the claims; its own test covers that.
    expect(sessionManager.discardBufferedWork).toHaveBeenCalledWith(910001);
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
  });

  it('provider_switch preserves the live buffer across a switch', async () => {
    const session = makeSession(910002);
    const { sessionManager, completionHandler } = makeDeps();

    await handleGeneratorExit(session, 'provider_switch', {
      sessionManager: sessionManager as any,
      completionHandler: completionHandler as any,
    });

    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
    expect(session.pausedReason).toBe('provider_switch');
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

  /**
   * C1: a model id the endpoint does not serve — whether the host chose it or
   * we did — is an auth-category exit, so pending inference inputs are discarded
   * and no later paid rescue starts. It is NOT auth_invalid, so no long
   * credential cooldown is armed. Both codes share the same abort reason and
   * the same discard path; only the classified code differs.
   */
  for (const [name, code] of [
    ['host-not-served-discards-pending', HOST_MODEL_NOT_SERVED_CODE],
    ['own-not-served-discards-pending', OWN_MODEL_NOT_SERVED_CODE],
  ] as const) {
    it(name, async () => {
      const provider = new OpenAICompatProvider({} as never, {} as never);
      const error = new ClassifiedProviderError('OpenAI-compatible endpoint refused the model id', {
        kind: 'unrecoverable',
        cause: new Error('x'),
        code,
      });

      // preservingAbortReason is the single mapping from a classified error to
      // the exit reason the handler consumes; exercised here through the real
      // provider instance rather than by hard-coding the reason string.
      const reason = (provider as any).preservingAbortReason(error) as string | null;
      expect(reason).toBe('auth:host_model_not_served');
      expect(abortCategoryOf(reason)).toBe('auth');

      const session = makeSession(910006);
      const { sessionManager, completionHandler, messageBuffer } = makeDeps();
      const claimSummarizeRescue = mock(() => true);
      const hasPendingSummarize = mock(() => true);
      const resumeGenerator = mock(() => {});

      await handleGeneratorExit(session, reason, {
        sessionManager: {
          ...sessionManager,
          claimSummarizeRescue,
          hasPendingSummarize,
        } as any,
        completionHandler: completionHandler as any,
        resumeGenerator,
      });

      expect(messageBuffer.getPendingCount).not.toHaveBeenCalled();
      expect(sessionManager.discardBufferedWork).toHaveBeenCalledWith(910006);
      expect(sessionManager.clearPendingForSession).not.toHaveBeenCalled();
      expect(claimSummarizeRescue).not.toHaveBeenCalled();
      expect(resumeGenerator).not.toHaveBeenCalled();
      expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
      expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
      expect(session.pausedReason).toBe('auth');
    });
  }
});
