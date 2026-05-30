import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

// No supervisor/process-registry mocks: respawnPoisonedSession only calls
// getSdkProcessForSession (returns undefined for a session that never spawned
// an SDK subprocess) and does not call getSupervisor, so the real modules are
// safe here. Mocking them with mock.module would leak globally across the bun
// run and break the supervisor/shutdown test suites.

// Snapshot the real module namespaces BEFORE mock.module mutates the live,
// process-global registry. bun's mock.module is sticky and mock.restore() does
// NOT undo it, so we re-register these snapshots in afterAll. The spreads must
// run as executable statements textually before the corresponding mock.module
// calls so they capture the real exports (e.g. worker-service's
// buildStatusOutput) before the registry is clobbered.
import * as realModeManagerNs from '../../src/services/domain/ModeManager.js';
import * as realWorkerUtilsNs from '../../src/shared/worker-utils.js';
import * as realWorkerServiceNs from '../../src/services/worker-service.js';
const realModeManager = { ...realModeManagerNs };
const realWorkerUtils = { ...realWorkerUtilsNs };
const realWorkerService = { ...realWorkerServiceNs };

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({ getWorkerPort: () => 37777 }));
mock.module('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse, INVALID_OUTPUT_RESPAWN_THRESHOLD } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

/**
 * Drive the real generator-exit lifecycle without standing up the full
 * SessionRoutes (which would pull in the SDK providers and the process-global
 * supervisor registry that this suite deliberately keeps unmocked). This mirrors
 * SessionRoutes.startGeneratorWithProvider EXACTLY: reset an aborted controller
 * for a fresh spawn, assign the generator promise, then on .finally() read and
 * consume session.abortReason and hand it to the real handleGeneratorExit. The
 * `startSession` callback stands in for the provider's generator body.
 */
async function runGeneratorLifecycle(
  sm: SessionManager,
  session: ActiveSession,
  completionHandler: Pick<SessionCompletionHandler, 'finalizeSession'>,
  startSession: (session: ActiveSession) => Promise<void>
): Promise<void> {
  if (session.abortController.signal.aborted) {
    session.abortController = new AbortController();
  }
  session.currentProvider = 'claude';
  session.generatorPromise = startSession(session)
    .catch(() => { /* generator failed: batch dropped, transcript is recovery */ })
    .finally(async () => {
      const reason = session.abortReason ?? null;
      session.abortReason = null;
      await handleGeneratorExit(session, reason, {
        sessionManager: sm,
        completionHandler: completionHandler as SessionCompletionHandler,
      });
    });
  await session.generatorPromise;
}

function makeDbManager(): DatabaseManager {
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
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const mockWorker = { broadcastProcessingStatus: () => {} } as unknown as WorkerRef;

let spies: ReturnType<typeof spyOn>[] = [];

describe('poison respawn (plan-11 #2485)', () => {
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
  });

  afterAll(() => {
    mock.module('../../src/services/worker-service.js', () => realWorkerService);
    mock.module('../../src/shared/worker-utils.js', () => realWorkerUtils);
    mock.module('../../src/services/domain/ModeManager.js', () => realModeManager);
  });

  it('respawns immediately on a poisoned closure string and preserves pending messages', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    session.memorySessionId = 'mem-1';

    // Buffer two pending observations that must survive a respawn.
    await sm.queueObservation(1, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-1',
    });
    await sm.queueObservation(1, {
      tool_name: 'Edit', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-2',
    });
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);

    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    await processAgentResponse(
      'This session has been exhausted; I cannot continue.',
      session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
    );

    expect(respawnSpy).toHaveBeenCalledWith(1);
    // Pending messages preserved (buffer NOT disposed) so the fresh generator reprocesses them.
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(2);
    // Session still active (not deleted) and abort fired for a fresh spawn.
    expect(sm.getSession(1)).toBeDefined();
    expect(session.abortController.signal.aborted).toBe(true);
    expect(session.consecutiveInvalidOutputs).toBe(0); // reset on respawn
  });

  it('never respawns on benign idle (empty) output, no matter how many', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(7, 'do the thing', 1);
    session.memorySessionId = 'mem-7';
    await sm.queueObservation(7, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-idle',
    });

    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    // Far more empty/whitespace outputs than the prose threshold. `idle` is
    // benign ("nothing to observe") and must never accumulate toward respawn,
    // or trivial sessions (e.g. a short one-shot `opencode run`) get killed
    // before they can summarize.
    for (let i = 0; i < INVALID_OUTPUT_RESPAWN_THRESHOLD + 3; i++) {
      await processAgentResponse(
        i % 2 === 0 ? '' : '   \n  ',
        session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
      );
    }

    expect(respawnSpy).not.toHaveBeenCalled();
    expect(session.consecutiveInvalidOutputs).toBe(0);
  });

  it('respawns only after N consecutive prose outputs, not on the first', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await sm.queueObservation(2, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-a',
    });

    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    // First (threshold - 1) prose responses must NOT respawn.
    for (let i = 0; i < INVALID_OUTPUT_RESPAWN_THRESHOLD - 1; i++) {
      await processAgentResponse(
        'Just some prose, no XML here.',
        session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
      );
    }
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(session.consecutiveInvalidOutputs).toBe(INVALID_OUTPUT_RESPAWN_THRESHOLD - 1);

    // The Nth invalid output crosses the threshold and triggers respawn.
    await processAgentResponse(
      'Still just prose.',
      session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent'
    );
    expect(respawnSpy).toHaveBeenCalledWith(2);
  });

  it('respawnPoisonedSession preserves the buffer and resets context', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    session.conversationHistory.push({ role: 'assistant', content: 'poisoned turn' });
    session.consecutiveInvalidOutputs = 5;
    await sm.queueObservation(3, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-x',
    });

    await sm.respawnPoisonedSession(3);

    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1); // preserved
    expect(sm.getSession(3)).toBeDefined();
    expect(session.conversationHistory).toHaveLength(0);
    expect(session.consecutiveInvalidOutputs).toBe(0);
    expect(session.memorySessionId).toBeNull();
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('handleGeneratorExit preserves session and buffer on a "poisoned" exit', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(11, 'do the thing', 1);
    await sm.queueObservation(11, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-p1',
    });
    expect(sm.getMessageBuffer().getPendingCount(11)).toBe(1);
    session.generatorPromise = Promise.resolve();
    session.currentProvider = 'claude';

    const finalizeSession = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'poisoned', {
      sessionManager: sm,
      completionHandler: { finalizeSession } as unknown as SessionCompletionHandler,
    });

    // Buffer NOT disposed, session NOT removed, no finalization on poison.
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sm.getSession(11)).toBeDefined();
    expect(sm.getMessageBuffer().getPendingCount(11)).toBe(1);
    // Dead generator still torn down so the next ensureGeneratorRunning starts fresh.
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('handleGeneratorExit finalizes and removes the session on a non-poison exit', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(12, 'do the thing', 1);
    await sm.queueObservation(12, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-i1',
    });
    session.generatorPromise = Promise.resolve();

    const finalizeSession = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'idle', {
      sessionManager: sm,
      completionHandler: { finalizeSession } as unknown as SessionCompletionHandler,
    });

    expect(finalizeSession).toHaveBeenCalledTimes(1);
    expect(sm.getSession(12)).toBeUndefined();
    expect(sm.getMessageBuffer().getPendingCount(12)).toBe(0); // buffer disposed
  });

  it('full lifecycle: poisoned exit preserves the buffer, then a fresh generator drains it', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(20, 'do the thing', 1);
    session.memorySessionId = 'mem-20';
    await sm.queueObservation(20, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-l1',
    });
    await sm.queueObservation(20, {
      tool_name: 'Edit', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-l2',
    });
    expect(sm.getMessageBuffer().getPendingCount(20)).toBe(2);

    const finalizeSession = mock(() => Promise.resolve());
    const completionHandler = { finalizeSession };

    // Round 1: the generator gets poisoned mid-run and respawns. This exercises
    // the real respawnPoisonedSession -> .finally() -> handleGeneratorExit path.
    await runGeneratorLifecycle(sm, session, completionHandler, async (s) => {
      await sm.respawnPoisonedSession(s.sessionDbId);
    });

    // The poisoned exit must NOT finalize/evict: session and buffer survive so the
    // preserved pending messages can be reprocessed (the previously-missing behavior).
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sm.getSession(20)).toBeDefined();
    expect(sm.getMessageBuffer().getPendingCount(20)).toBe(2);
    expect(session.generatorPromise).toBeNull();
    expect(session.abortController.signal.aborted).toBe(true);

    // Round 2: the next ingest's ensureGeneratorRunning equivalent starts a fresh
    // generator. It must see a reset (non-aborted) controller and the intact buffer.
    let observed: { pending: number; aborted: boolean } | null = null;
    await runGeneratorLifecycle(sm, session, completionHandler, async (s) => {
      observed = {
        pending: sm.getMessageBuffer().getPendingCount(s.sessionDbId),
        aborted: s.abortController.signal.aborted,
      };
      // Drain the preserved work, then exit normally (reason === null).
      await sm.clearPendingForSession(s.sessionDbId);
    });

    expect(observed).toEqual({ pending: 2, aborted: false });
    // A normal (non-poison) exit then finalizes and evicts the now-drained session.
    expect(finalizeSession).toHaveBeenCalledTimes(1);
    expect(sm.getSession(20)).toBeUndefined();
    expect(sm.getMessageBuffer().getPendingCount(20)).toBe(0);
  });
});
