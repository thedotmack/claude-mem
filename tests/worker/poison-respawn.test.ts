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
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { DEFAULT_RESPAWN_THRESHOLD, clearRespawnPolicyCache } from '../../src/services/worker/agents/respawn-policy.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

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
    clearRespawnPolicyCache();
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
    expect(session.invalidOutputWindow.badCount).toBe(0); // reset on respawn
  });

  it('respawns after N prose outputs within the window, not on the first', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await sm.queueObservation(2, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-a',
    });
    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    for (let i = 0; i < DEFAULT_RESPAWN_THRESHOLD - 1; i++) {
      await processAgentResponse('Just some prose, no XML here.',
        session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');
    }
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(session.invalidOutputWindow.badCount).toBe(DEFAULT_RESPAWN_THRESHOLD - 1);

    await processAgentResponse('Still just prose.',
      session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');
    expect(respawnSpy).toHaveBeenCalledWith(2);
  });

  it('does NOT respawn on benign idle outputs (the poison-loop fix, #3032)', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(5, 'do the thing', 1);
    session.memorySessionId = 'mem-5';
    await sm.queueObservation(5, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-i',
    });
    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    // Empty string classifies as 'idle'. Far more than the threshold.
    for (let i = 0; i < DEFAULT_RESPAWN_THRESHOLD + 3; i++) {
      await processAgentResponse('', session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');
    }
    expect(respawnSpy).not.toHaveBeenCalled();
    expect(session.invalidOutputWindow.badCount).toBe(0);
  });

  it('respawnPoisonedSession preserves the buffer and resets context', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    session.conversationHistory.push({ role: 'assistant', content: 'poisoned turn' });
    session.invalidOutputWindow = { windowStart: Date.now(), badCount: 5 };
    await sm.queueObservation(3, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-x',
    });

    await sm.respawnPoisonedSession(3);

    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1); // preserved
    expect(sm.getSession(3)).toBeDefined();
    expect(session.conversationHistory).toHaveLength(0);
    expect(session.invalidOutputWindow.badCount).toBe(0);
    expect(session.memorySessionId).toBeNull();
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('a valid parse resets the failure window (positive path)', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(6, 'do the thing', 1);
    // memorySessionId intentionally left null: the valid path resets the window,
    // then returns at the `if (!session.memorySessionId)` gate before storage.
    await sm.queueObservation(6, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-v',
    });
    const respawnSpy = spyOn(sm, 'respawnPoisonedSession');

    await processAgentResponse('prose one', session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');
    await processAgentResponse('prose two', session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');
    expect(session.invalidOutputWindow.badCount).toBe(2);

    const validXml =
      '<observation><type>discovery</type><title>real</title><narrative>n</narrative></observation>';
    await processAgentResponse(validXml, session, makeDbManager(), sm, mockWorker, 0, null, 'TestAgent');

    expect(session.invalidOutputWindow.badCount).toBe(0); // reset on valid parse
    expect(respawnSpy).not.toHaveBeenCalled();
  });
});
