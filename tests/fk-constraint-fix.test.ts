/**
 * Tests for FK constraint fix (Issue #846)
 *
 * Problem: When worker restarts, observations fail because:
 * 1. Session created with memory_session_id = NULL
 * 2. SDK generates new memory_session_id
 * 3. storeObservation() tries to INSERT with new ID
 * 4. FK constraint fails - parent row doesn't have this ID yet
 *
 * Fix: ensureMemorySessionIdRegistered() updates parent table before child INSERT
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('FK Constraint Fix (Issue #846)', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    // Use unique temp database for each test (randomUUID prevents collision in parallel runs)
    testDbPath = `/tmp/test-fk-fix-${crypto.randomUUID()}.db`;
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    // Clean up test database
    try {
      require('fs').unlinkSync(testDbPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should auto-register memory_session_id before observation INSERT', () => {
    // Create session with NULL memory_session_id (simulates initial creation)
    const sessionDbId = store.createSDKSession('test-content-id', 'test-project', 'test prompt');

    // Verify memory_session_id starts as NULL
    const beforeSession = store.getSessionById(sessionDbId);
    expect(beforeSession?.memory_session_id).toBeNull();

    // Simulate SDK providing new memory_session_id
    const newMemorySessionId = 'new-uuid-from-sdk-' + Date.now();

    // Call ensureMemorySessionIdRegistered (the fix)
    store.ensureMemorySessionIdRegistered(sessionDbId, newMemorySessionId);

    // Verify parent table was updated
    const afterSession = store.getSessionById(sessionDbId);
    expect(afterSession?.memory_session_id).toBe(newMemorySessionId);

    // Now storeObservation should succeed (FK target exists)
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
    // Create session
    const sessionDbId = store.createSDKSession('test-content-id-2', 'test-project', 'test prompt');
    const memorySessionId = 'fixed-memory-id-' + Date.now();

    // Register it once
    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

    // Call again with same ID - should be a no-op
    store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

    // Verify still has the same ID
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
    // Simulate: Session exists from previous worker instance
    const sessionDbId = store.createSDKSession('restart-test-id', 'test-project', 'test prompt');

    // Simulate: Previous worker had set a memory_session_id
    const oldMemorySessionId = 'old-stale-id';
    store.updateMemorySessionId(sessionDbId, oldMemorySessionId);

    // Verify old ID is set
    const before = store.getSessionById(sessionDbId);
    expect(before?.memory_session_id).toBe(oldMemorySessionId);

    // Simulate: New worker gets new memory_session_id from SDK
    const newMemorySessionId = 'new-fresh-id-from-sdk';

    // The fix: ensure new ID is registered before storage
    store.ensureMemorySessionIdRegistered(sessionDbId, newMemorySessionId);

    // Verify update happened
    const after = store.getSessionById(sessionDbId);
    expect(after?.memory_session_id).toBe(newMemorySessionId);

    // Storage should now succeed
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
});
