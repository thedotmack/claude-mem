
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { ClaudeProvider } from '../src/services/worker/ClaudeProvider.js';

describe('FK Constraint Fix (Issue #846)', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/test-fk-fix-${crypto.randomUUID()}.db`;
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    try {
      require('fs').unlinkSync(testDbPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should auto-register memory_session_id before observation INSERT', () => {
    const sessionDbId = store.createSDKSession('test-content-id', 'test-project', 'test prompt');

    const beforeSession = store.getSessionById(sessionDbId);
    expect(beforeSession?.memory_session_id).toBeNull();

    const newMemorySessionId = 'new-uuid-from-sdk-' + Date.now();

    store.ensureMemorySessionIdRegistered(sessionDbId, newMemorySessionId);

    const afterSession = store.getSessionById(sessionDbId);
    expect(afterSession?.memory_session_id).toBe(newMemorySessionId);

    const result = store.storeObservation(
      newMemorySessionId,
      'test-project',
      {
        type: 'discovery',
        title: 'Test observation',
        subtitle: 'Testing FK fix',
        facts: ['fact1'],
        narrative: 'Test narrative',
        concepts: ['test'],
        files_read: [],
        files_modified: []
      },
      1,
      100
    );

    expect(result.id).toBeGreaterThan(0);
  });

  it('should not update if memory_session_id already matches', () => {
    const sessionDbId = store.createSDKSession('test-content-id-2', 'test-project', 'test prompt');
    const memorySessionId = 'fixed-memory-id-' + Date.now();

    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

    const session = store.getSessionById(sessionDbId);
    expect(session?.memory_session_id).toBe(memorySessionId);
  });

  it('should throw if session does not exist', () => {
    const nonExistentSessionId = 99999;

    expect(() => {
      store.ensureMemorySessionIdRegistered(nonExistentSessionId, 'some-id');
    }).toThrow('Session 99999 not found in sdk_sessions');
  });

  it('should handle observation storage after worker restart scenario', () => {
    const sessionDbId = store.createSDKSession('restart-test-id', 'test-project', 'test prompt');

    const oldMemorySessionId = 'old-stale-id';
    store.updateMemorySessionId(sessionDbId, oldMemorySessionId);

    const before = store.getSessionById(sessionDbId);
    expect(before?.memory_session_id).toBe(oldMemorySessionId);

    const newMemorySessionId = 'new-fresh-id-from-sdk';

    store.ensureMemorySessionIdRegistered(sessionDbId, newMemorySessionId);

    const after = store.getSessionById(sessionDbId);
    expect(after?.memory_session_id).toBe(newMemorySessionId);

    const result = store.storeObservation(
      newMemorySessionId,
      'test-project',
      {
        type: 'bugfix',
        title: 'Worker restart fix test',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }
    );

    expect(result.id).toBeGreaterThan(0);
  });

  it('preserves the persisted memory session id when starting a fresh observer session', async () => {
    const sessionDbId = store.createSDKSession('provider-reset-id', 'test-project', 'test prompt');
    const memorySessionId = 'carried-memory-id';

    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
    store.storeObservation(
      memorySessionId,
      'test-project',
      {
        type: 'discovery',
        title: 'Existing child row',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }
    );

    const updateCalls: Array<{ id: number; value: string | null }> = [];
    store.updateMemorySessionId = (id, value) => {
      updateCalls.push({ id, value });
    };

    const provider = new ClaudeProvider({ getSessionStore: () => store } as any, {} as any);
    const abortController = new AbortController();
    abortController.abort();
    const session = {
      sessionDbId,
      contentSessionId: 'content-session',
      memorySessionId,
      project: 'test-project',
      userPrompt: 'test prompt',
      modelOverride: 'test-model',
      abortController,
      lastPromptNumber: 1,
      conversationHistory: [],
      pendingAgentId: null,
      pendingAgentType: null,
      forceInit: false,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      lastResultTotalCostUsd: null,
    } as any;

    await expect(provider.startSession(session)).rejects.toThrow();

    expect(updateCalls).toEqual([]);
    expect(session.memorySessionId).toBeNull();
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe(memorySessionId);
  });
});
