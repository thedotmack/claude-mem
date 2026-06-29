import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

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

describe('observer invalid-output handling (Phase 3 recovery)', () => {
  beforeEach(() => {
    spies = [
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
});
