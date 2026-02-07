import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

/**
 * Session ID Usage Validation - Smoke Tests for Critical Invariants
 *
 * These tests validate the most critical behaviors of the dual session ID system:
 * - contentSessionId: User's Claude Code conversation session (immutable)
 * - memorySessionId: SDK agent's session ID for resume (captured from SDK response)
 *
 * CRITICAL INVARIANTS:
 * 1. Cross-contamination prevention: Observations from different sessions never mix
 * 2. Resume safety: Resume only allowed when memorySessionId is actually captured (non-NULL)
 * 3. 1:1 mapping: Each contentSessionId maps to exactly one memorySessionId
 */
describe('Session ID Critical Invariants', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('Cross-Contamination Prevention', () => {
    it('should never mix observations from different content sessions', () => {
      // Create two independent sessions
      const content1 = 'user-session-A';
      const content2 = 'user-session-B';
      const memory1 = 'memory-session-A';
      const memory2 = 'memory-session-B';

      const id1 = store.createSDKSession(content1, 'project-a', 'Prompt A');
      const id2 = store.createSDKSession(content2, 'project-b', 'Prompt B');
      store.updateMemorySessionId(id1, memory1);
      store.updateMemorySessionId(id2, memory2);

      // Store observations in each session
      store.storeObservation(memory1, 'project-a', {
        type: 'discovery',
        title: 'Observation A',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }, 1);

      store.storeObservation(memory2, 'project-b', {
        type: 'discovery',
        title: 'Observation B',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }, 1);

      // CRITICAL: Each session's observations must be isolated
      const obsA = store.getObservationsForSession(memory1);
      const obsB = store.getObservationsForSession(memory2);

      expect(obsA.length).toBe(1);
      expect(obsB.length).toBe(1);
      expect(obsA[0].title).toBe('Observation A');
      expect(obsB[0].title).toBe('Observation B');

      // Verify no cross-contamination: A's query doesn't return B's data
      expect(obsA.some(o => o.title === 'Observation B')).toBe(false);
      expect(obsB.some(o => o.title === 'Observation A')).toBe(false);
    });
  });

  describe('Resume Safety', () => {
    it('should prevent resume when memorySessionId is NULL (not yet captured)', () => {
      const contentSessionId = 'new-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');

      const session = store.getSessionById(sessionDbId);

      // CRITICAL: Before SDK returns real session ID, memory_session_id must be NULL
      expect(session?.memory_session_id).toBeNull();

      // hasRealMemorySessionId check: only resume when non-NULL
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(false);

      // Resume options should be empty (no resume parameter)
      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({});
    });

    it('should allow resume only after memorySessionId is captured', () => {
      const contentSessionId = 'resume-ready-session';
      const capturedMemoryId = 'sdk-returned-session-xyz';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt');

      // Before capture
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();

      // Capture memory session ID (simulates SDK response)
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // After capture
      session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      expect(hasRealMemorySessionId).toBe(true);
      expect(session?.memory_session_id).toBe(capturedMemoryId);
      expect(session?.memory_session_id).not.toBe(contentSessionId);
    });

    it('should preserve memorySessionId across createSDKSession calls (pure get-or-create)', () => {
      // createSDKSession is a pure get-or-create: it never modifies memory_session_id.
      // Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level,
      // and ensureMemorySessionIdRegistered updates the ID when a new generator captures one.
      const contentSessionId = 'multi-prompt-session';
      const firstMemoryId = 'first-generator-memory-id';

      // First generator creates session and captures memory ID
      let sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      store.updateMemorySessionId(sessionDbId, firstMemoryId);
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(firstMemoryId);

      // Second createSDKSession call preserves memory_session_id (no reset)
      sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(firstMemoryId); // Preserved, not reset

      // ensureMemorySessionIdRegistered can update to a new ID (ON UPDATE CASCADE handles FK)
      store.ensureMemorySessionIdRegistered(sessionDbId, 'second-generator-memory-id');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe('second-generator-memory-id');
    });

    it('should NOT reset memorySessionId when it is still NULL (first prompt scenario)', () => {
      // When memory_session_id is NULL, createSDKSession should NOT reset it
      // This is the normal first-prompt scenario where SDKAgent hasn't captured the ID yet
      const contentSessionId = 'new-session';

      // First createSDKSession - creates row with NULL memory_session_id
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();

      // Second createSDKSession (before SDK has returned) - should still be NULL, no reset needed
      store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();
    });
  });

  describe('UNIQUE Constraint Enforcement', () => {
    it('should prevent duplicate memorySessionId (protects against multiple transcripts)', () => {
      const content1 = 'content-session-1';
      const content2 = 'content-session-2';
      const sharedMemoryId = 'shared-memory-id';

      const id1 = store.createSDKSession(content1, 'project', 'Prompt 1');
      const id2 = store.createSDKSession(content2, 'project', 'Prompt 2');

      // First session captures memory ID - should succeed
      store.updateMemorySessionId(id1, sharedMemoryId);

      // Second session tries to use SAME memory ID - should FAIL
      expect(() => {
        store.updateMemorySessionId(id2, sharedMemoryId);
      }).toThrow(); // UNIQUE constraint violation

      // First session still has the ID
      const session1 = store.getSessionById(id1);
      expect(session1?.memory_session_id).toBe(sharedMemoryId);
    });
  });

  describe('Foreign Key Integrity', () => {
    it('should reject observations for non-existent sessions', () => {
      expect(() => {
        store.storeObservation('nonexistent-session-id', 'test-project', {
          type: 'discovery',
          title: 'Invalid FK',
          subtitle: null,
          facts: [],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: []
        }, 1);
      }).toThrow(); // FK constraint violation
    });
  });
});
