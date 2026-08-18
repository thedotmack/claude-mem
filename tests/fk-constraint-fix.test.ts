
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

  it('should survive a second generator pass over a session that already has child rows (#3628)', () => {
    // A worker that already stored data for a session starts a second
    // generator pass. The old code wrote NULL to sdk_sessions.memory_session_id
    // to force a fresh SDK start. That NULL cascaded through ON UPDATE CASCADE
    // into the NOT NULL child columns and rolled back the whole transaction.
    // The fix resets only the in-memory ID, so re-keying and storing still work.
    const sessionDbId = store.createSDKSession('second-pass-id', 'test-project', 'test prompt');
    const firstMemorySessionId = 'first-pass-memory-id';

    store.ensureMemorySessionIdRegistered(sessionDbId, firstMemorySessionId);
    store.storeObservation(
      firstMemorySessionId,
      'test-project',
      {
        type: 'discovery',
        title: 'First pass observation',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }
    );
    store.storeSummary(
      firstMemorySessionId,
      'test-project',
      {
        request: 'req',
        investigated: 'inv',
        learned: 'learn',
        completed: 'done',
        next_steps: 'next',
        notes: null
      }
    );

    // A NULL write with child rows present is the crash the fix removes.
    expect(() => {
      store.updateMemorySessionId(sessionDbId, null);
    }).toThrow(/NOT NULL constraint failed/);

    // The session ID and its child rows stay intact after the failed write.
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe(firstMemorySessionId);

    // The second pass captures a fresh SDK id and re-keys through the
    // supported path. Storing new child rows succeeds.
    const secondMemorySessionId = 'second-pass-memory-id';
    store.ensureMemorySessionIdRegistered(sessionDbId, secondMemorySessionId);
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe(secondMemorySessionId);

    const result = store.storeObservation(
      secondMemorySessionId,
      'test-project',
      {
        type: 'discovery',
        title: 'Second pass observation',
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

  it('ClaudeProvider start must reset the carried memory id in memory only, never in the database (#3628)', () => {
    // Drive the changed provider path directly. A second generator pass over a
    // session that already has child rows must leave the stored
    // memory_session_id untouched. A NULL write here would cascade into the
    // NOT NULL child columns and roll back the storage transaction.
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

    // Fail the test if the provider writes to memory_session_id at all.
    let updateCalled = false;
    const originalUpdate = store.updateMemorySessionId.bind(store);
    store.updateMemorySessionId = (id, value) => {
      updateCalled = true;
      return originalUpdate(id, value);
    };

    const dbManager = { getSessionStore: () => store } as any;
    const provider = new ClaudeProvider(dbManager, {} as any);
    const session = { sessionDbId, memorySessionId } as any;

    (provider as any).resetCarriedMemorySessionId(session);

    expect(updateCalled).toBe(false);
    expect(session.memorySessionId).toBeNull();
    expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe(memorySessionId);
  });
});
