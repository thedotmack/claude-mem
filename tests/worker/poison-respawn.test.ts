import { describe, it, expect, mock, beforeAll, beforeEach, afterAll, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../../src/services/domain/types.js';

function makeDbManager(storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }))): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const makeWorker = (): WorkerRef => ({
  broadcastProcessingStatus: mock(() => {}),
}) as unknown as WorkerRef;

class ReactiveQuotaTestProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'Gemini';
  protected readonly syntheticIdPrefix = 'gemini';
  protected readonly forwardEmptyMessageResponse = false;
  private queryCount = 0;
  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    private readonly failure: unknown,
    private readonly failOnMessageLoop = false,
  ) {
    super(dbManager, sessionManager);
  }
  protected getConfig() { return { apiKey: 'test-key', model: 'gemini-test' }; }
  protected missingApiKeyError(): Error { return new Error('missing key'); }
  protected async query(_history: ConversationMessage[], _config: { apiKey: string; model: string }): Promise<ProviderQueryResult> {
    if (this.failOnMessageLoop && this.queryCount++ === 0) {
      return { content: '' };
    }
    throw this.failure;
  }
  protected estimateTokens(): number { return 0; }
  protected buildLastUsage(): ActiveSession['lastUsage'] { return null; }
}

async function runReactiveProviderExit(
  kind: 'quota_exhausted' | 'rate_limit' | 'auth_invalid' | 'unrecoverable' | 'transient',
  sessionDbId: number,
  project = 'origin-project',
): Promise<{ session: ActiveSession; sessionManager: SessionManager; finalizeSession: ReturnType<typeof mock>; removeSession: ReturnType<typeof spyOn>; error: unknown; expectedError: unknown }> {
  const sessionManager = new SessionManager(makeDbManager());
  const session = sessionManager.initializeSession(sessionDbId, 'do the thing', 1);
  session.memorySessionId = `mem-${sessionDbId}`;
  session.project = project;
  session.generatorPromise = Promise.resolve();
  await queueAndClaimOne(sessionManager, sessionDbId);
  const error = kind === 'unrecoverable' || kind === 'transient'
    ? new ClassifiedProviderError(`${kind} failure`, { kind, cause: new Error('provider') })
    : new ClassifiedProviderError(
      kind === 'auth_invalid' ? 'Gemini auth invalid (status 401)' : 'Gemini quota exhausted (status 429)',
      { kind, cause: new Error('provider') },
    );
  const provider = new ReactiveQuotaTestProvider(makeDbManager(), sessionManager, error, true);
  let thrown: unknown;
  try {
    await provider.startSession(session, makeWorker());
  } catch (caught) {
    thrown = caught;
  }
  const finalizeSession = mock(() => Promise.resolve());
  const removeSession = spyOn(sessionManager, 'removeSessionImmediate');
  spies.push(removeSession);
  await handleGeneratorExit(session, session.abortReason, {
    sessionManager,
    completionHandler: { finalizeSession } as any,
  });
  return { session, sessionManager, finalizeSession, removeSession, error: thrown, expectedError: error };
}

async function queueAndClaimOne(sm: SessionManager, sessionDbId: number): Promise<void> {
  await sm.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId: `tu-${sessionDbId}`,
  });

  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  expect(sm.getMessageBuffer().getPendingCount(sessionDbId)).toBe(1);
  await iterator.return?.();
}

let spies: ReturnType<typeof spyOn>[] = [];
let testMode: ModeConfig;
let previousModeId: string | null = null;

beforeAll(() => {
  const manager = ModeManager.getInstance();
  try {
    previousModeId = manager.getActiveModeId();
  } catch {
    previousModeId = null;
  }
  testMode = manager.loadMode('code');
});

afterAll(() => {
  if (previousModeId && previousModeId !== 'code') {
    ModeManager.getInstance().loadMode(previousModeId);
  }
});

describe('observer invalid-output handling (Phase 3 recovery)', () => {
  beforeEach(() => {
    spies = [
      spyOn(ModeManager.getInstance(), 'getActiveMode').mockReturnValue(testMode),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it('drops context-window prose that is not valid XML without aborting or preserving the claimed batch', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    session.memorySessionId = 'mem-1';
    session.consecutiveInvalidOutputs = 2;
    await queueAndClaimOne(sm, 1);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'I hit the context window and cannot continue <observation>',
      session,
      makeDbManager(),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).toHaveBeenCalledWith(1);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(0);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).toBeNull();
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(session.abortReason ?? null).toBeNull();
  });

  it('repeated "No observations to record" acknowledgements confirm and never build respawn debt', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await queueAndClaimOne(sm, 2);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    for (let i = 0; i < 5; i++) {
      await processAgentResponse(
        'No observations to record.',
        session,
        makeDbManager(),
        sm,
        makeWorker(),
        0,
        null,
        'TestAgent',
      );
      expect(session.consecutiveInvalidOutputs).toBe(0);
      expect(session.abortController.signal.aborted).toBe(false);
    }

    expect(confirmSpy).toHaveBeenCalledTimes(5);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(2)).toBe(0);
    expect(session.claimedMessageIds).toEqual([]);
  });

  it('pauses on weekly-limit quota prose and preserves claimed pending work', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    session.consecutiveInvalidOutputs = 2;
    await queueAndClaimOne(sm, 3);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon, so please try again later.',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(3);
    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.abortReason).toBe('quota:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });

  it('pauses on auth-failure prose without confirming or storing the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(7, 'do the thing', 1);
    session.memorySessionId = 'mem-7';
    session.consecutiveInvalidOutputs = 2;
    await queueAndClaimOne(sm, 7);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(7);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(7)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).not.toBeNull();
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('pauses on a bare unauthorized status and preserves the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(9, 'do the thing', 1);
    session.memorySessionId = 'mem-9';
    await queueAndClaimOne(sm, 9);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      '401 Unauthorized',
      session,
      makeDbManager(storeObservations),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(9);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(9)).toBe(1);
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('confirms unrelated login instructions as ordinary prose', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(10, 'do the thing', 1);
    session.memorySessionId = 'mem-10';
    await queueAndClaimOne(sm, 10);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      'Please run /login in the observed project instructions.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).toHaveBeenCalledWith(10);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(10)).toBe(0);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('confirms project auth-guide prose as ordinary prose', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(11, 'do the thing', 1);
    session.memorySessionId = 'mem-11';
    await queueAndClaimOne(sm, 11);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      'The project authentication guide says to run /login before testing.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).toHaveBeenCalledWith(11);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(11)).toBe(0);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('auth generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(8, 'do the thing', 1);
    session.memorySessionId = 'mem-8';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 8);

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(8)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(8)).toBe(1);
  });

  it('quota generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(6, 'do the thing', 1);
    session.memorySessionId = 'mem-6';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 6);

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(6)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(6)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('confirms skip/no-op prose but preserves the same queue shape for quota pause', async () => {
    const skipSm = new SessionManager(makeDbManager());
    const skipSession = skipSm.initializeSession(4, 'do the thing', 1);
    skipSession.memorySessionId = 'mem-4';
    await queueAndClaimOne(skipSm, 4);

    await processAgentResponse(
      'No observations to record.',
      skipSession,
      makeDbManager(),
      skipSm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const quotaSm = new SessionManager(makeDbManager());
    const quotaSession = quotaSm.initializeSession(5, 'do the thing', 1);
    quotaSession.memorySessionId = 'mem-5';
    await queueAndClaimOne(quotaSm, 5);

    await processAgentResponse(
      'Your subscription weekly quota has been exhausted and resets later.',
      quotaSession,
      makeDbManager(),
      quotaSm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(skipSm.getMessageBuffer().getPendingCount(4)).toBe(0);
    expect(quotaSm.getMessageBuffer().getPendingCount(5)).toBe(1);
  });

  it.each(['quota_exhausted', 'rate_limit', 'auth_invalid'] as const)(
    'reactive %s errors preserve claimed work through provider exit',
    async (kind) => {
      const result = await runReactiveProviderExit(kind, kind === 'quota_exhausted' ? 12 : 13);

      expect(result.error).toBeInstanceOf(ClassifiedProviderError);
      expect(result.error).toBe(result.expectedError);
      expect(result.session.abortReason).toBe(kind === 'auth_invalid' ? `auth:${kind}` : `quota:${kind}`);
      expect(result.session.abortController.signal.aborted).toBe(false);
      expect(result.finalizeSession).not.toHaveBeenCalled();
      expect(result.removeSession).not.toHaveBeenCalled();
      expect(result.sessionManager.getSession(result.session.sessionDbId)).toBe(result.session);
      expect(result.session.claimedMessageIds).toEqual([]);
      expect(result.sessionManager.getClaimedMessages(result.session.sessionDbId)).toEqual([]);
      expect(result.sessionManager.getMessageBuffer().getPendingCount(result.session.sessionDbId)).toBe(1);
    },
  );

  it('preserves a worktree-adopted session without changing its parent project', async () => {
    const result = await runReactiveProviderExit('rate_limit', 14, 'parent-project');

    expect(result.session.project).toBe('parent-project');
    expect(result.session.abortReason).toBe('quota:rate_limit');
    expect(result.sessionManager.getMessageBuffer().getPendingCount(14)).toBe(1);
    expect(result.finalizeSession).not.toHaveBeenCalled();
  });

  it.each(['unrecoverable', 'transient'] as const)(
    'reactive %s errors retain fatal cleanup',
    async (kind) => {
      const result = await runReactiveProviderExit(kind, kind === 'unrecoverable' ? 15 : 16);

      expect(result.error).toBeInstanceOf(ClassifiedProviderError);
      expect(result.error).toBe(result.expectedError);
      expect(result.session.abortReason ?? null).toBeNull();
      expect(result.finalizeSession).toHaveBeenCalledWith(result.session.sessionDbId);
      expect(result.removeSession).toHaveBeenCalledWith(result.session.sessionDbId);
      expect(result.sessionManager.getSession(result.session.sessionDbId)).toBeUndefined();
      expect(result.sessionManager.getMessageBuffer().getPendingCount(result.session.sessionDbId)).toBe(0);
    },
  );

  it('keeps an unclassified reactive error on the existing fatal path', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(17, 'do the thing', 1);
    session.memorySessionId = 'mem-17';
    await queueAndClaimOne(sessionManager, 17);
    const error = new TypeError('provider transport failed');
    const provider = new ReactiveQuotaTestProvider(makeDbManager(), sessionManager, error);
    let thrown: unknown;
    try {
      await provider.startSession(session, makeWorker());
    } catch (caught) {
      thrown = caught;
    }
    const finalizeSession = mock(() => Promise.resolve());
    const removeSession = spyOn(sessionManager, 'removeSessionImmediate');
    spies.push(removeSession);
    await handleGeneratorExit(session, session.abortReason, {
      sessionManager,
      completionHandler: { finalizeSession } as any,
    });

    expect(thrown).toBe(error);
    expect(session.abortReason ?? null).toBeNull();
    expect(finalizeSession).toHaveBeenCalledWith(17);
    expect(removeSession).toHaveBeenCalledWith(17);
  });
});
