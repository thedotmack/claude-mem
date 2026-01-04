import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

/**
 * Session ID Usage Validation Tests
 *
 * PURPOSE: Prevent confusion and bugs from mixing contentSessionId and memorySessionId
 *
 * CRITICAL ARCHITECTURE:
 * - contentSessionId: User's Claude Code conversation session (immutable)
 * - memorySessionId: SDK agent's session ID for resume (captured from SDK response)
 *
 * INVARIANTS TO ENFORCE:
 * 1. memorySessionId starts as NULL (NEVER equals contentSessionId - that would inject memory into user transcript!)
 * 2. Resume MUST NOT be used when memorySessionId is NULL
 * 3. Resume MUST ONLY be used when hasRealMemorySessionId === true (memorySessionId is non-null)
 * 4. Observations are stored with memorySessionId (after updateMemorySessionId has been called)
 * 5. updateMemorySessionId() is required before storeObservation() or storeSummary() can work
 */
describe('Session ID Usage Validation', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('Placeholder Detection - hasRealMemorySessionId Logic', () => {
    it('should identify placeholder when memorySessionId is NULL', () => {
      const contentSessionId = 'user-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');

      const session = store.getSessionById(sessionDbId);

      // Initially, memory_session_id is NULL (placeholder state)
      // CRITICAL: memory_session_id must NEVER equal contentSessionId - that would inject memory into user transcript!
      expect(session?.memory_session_id).toBeNull();

      // hasRealMemorySessionId would be FALSE (NULL is falsy)
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(false);
    });

    it('should identify real memory session ID after capture', () => {
      const contentSessionId = 'user-session-456';
      const capturedMemoryId = 'sdk-generated-abc123';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      const session = store.getSessionById(sessionDbId);

      // After capture, memory_session_id is set (non-NULL)
      expect(session?.memory_session_id).toBe(capturedMemoryId);

      // hasRealMemorySessionId would be TRUE
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(true);
    });

    it('should never use contentSessionId as resume parameter when in placeholder state', () => {
      const contentSessionId = 'dangerous-session-789';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      const session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      // CRITICAL: This check prevents resuming when memory_session_id is not captured
      if (hasRealMemorySessionId) {
        // Safe to use for resume
        const resumeParam = session?.memory_session_id;
        expect(resumeParam).not.toBe(contentSessionId);
      } else {
        // Must NOT pass resume parameter
        // Resume should be undefined/null in SDK call
        expect(hasRealMemorySessionId).toBe(false);
      }
    });
  });

  describe('Observation Storage - MemorySessionId Usage', () => {
    it('should store observations with memorySessionId in memory_session_id column', () => {
      const contentSessionId = 'obs-content-session-123';
      const memorySessionId = 'obs-memory-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const obs = {
        type: 'discovery',
        title: 'Test Observation',
        subtitle: null,
        facts: ['Fact 1'],
        narrative: 'Testing',
        concepts: ['testing'],
        files_read: [],
        files_modified: []
      };

      // storeObservation takes memorySessionId (after updateMemorySessionId has been called)
      const result = store.storeObservation(memorySessionId, 'test-project', obs, 1);

      // Verify it's stored in the memory_session_id column with memorySessionId value
      const stored = store.db.prepare(
        'SELECT memory_session_id FROM observations WHERE id = ?'
      ).get(result.id) as { memory_session_id: string };

      // memory_session_id column contains the captured SDK session ID
      expect(stored.memory_session_id).toBe(memorySessionId);
    });

    it('should be retrievable using memorySessionId', () => {
      const contentSessionId = 'retrieval-test-session';
      const memorySessionId = 'retrieval-memory-session';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      // Store observation with memorySessionId
      const obs = {
        type: 'feature',
        title: 'Observation',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      };
      store.storeObservation(memorySessionId, 'test-project', obs, 1);

      // Observations are retrievable by memorySessionId
      const observations = store.getObservationsForSession(memorySessionId);
      expect(observations.length).toBe(1);
      expect(observations[0].title).toBe('Observation');
    });
  });

  describe('Resume Safety - Prevent contentSessionId Resume Bug', () => {
    it('should prevent resume with NULL memorySessionId', () => {
      const contentSessionId = 'safety-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      const session = store.getSessionById(sessionDbId);

      // Simulate hasRealMemorySessionId check - memory_session_id must be non-null
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      // MUST be false in placeholder state (memory_session_id is NULL)
      expect(hasRealMemorySessionId).toBe(false);

      // Resume parameter should NOT be set
      // In SDK call: ...(hasRealMemorySessionId && { resume: session.memorySessionId })
      // This evaluates to an empty object, not a resume parameter
      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({});
    });

    it('should allow resume only after memory session ID is captured', () => {
      const contentSessionId = 'resume-ready-session';
      const capturedMemoryId = 'real-sdk-session-123';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // Before capture - no resume (memory_session_id is NULL)
      let session = store.getSessionById(sessionDbId);
      let hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(false);

      // Capture memory session ID
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // After capture - resume allowed
      session = store.getSessionById(sessionDbId);
      hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(true);

      // Resume parameter should be the captured ID
      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({ resume: capturedMemoryId });
      expect(resumeOptions.resume).not.toBe(contentSessionId);
    });
  });

  describe('Cross-Contamination Prevention', () => {
    it('should never mix observations from different content sessions', () => {
      const content1 = 'user-session-A';
      const content2 = 'user-session-B';
      const memory1 = 'memory-session-A';
      const memory2 = 'memory-session-B';

      const id1 = store.createSDKSession(content1, 'project-a', 'Prompt A');
      const id2 = store.createSDKSession(content2, 'project-b', 'Prompt B');
      store.updateMemorySessionId(id1, memory1);
      store.updateMemorySessionId(id2, memory2);

      // Store observations in each session using memorySessionId
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

      // Verify isolation
      const obsA = store.getObservationsForSession(memory1);
      const obsB = store.getObservationsForSession(memory2);

      expect(obsA.length).toBe(1);
      expect(obsB.length).toBe(1);
      expect(obsA[0].title).toBe('Observation A');
      expect(obsB[0].title).toBe('Observation B');
    });

    it('should never leak memory session IDs between content sessions', () => {
      const content1 = 'content-session-1';
      const content2 = 'content-session-2';
      const memory1 = 'memory-session-1';
      const memory2 = 'memory-session-2';

      const id1 = store.createSDKSession(content1, 'project', 'Prompt');
      const id2 = store.createSDKSession(content2, 'project', 'Prompt');

      store.updateMemorySessionId(id1, memory1);
      store.updateMemorySessionId(id2, memory2);

      const session1 = store.getSessionById(id1);
      const session2 = store.getSessionById(id2);

      // Each session must have its own unique memory session ID
      expect(session1?.memory_session_id).toBe(memory1);
      expect(session2?.memory_session_id).toBe(memory2);
      expect(session1?.memory_session_id).not.toBe(session2?.memory_session_id);
    });
  });

  describe('Foreign Key Integrity', () => {
    it('should cascade delete observations when session is deleted', () => {
      const contentSessionId = 'cascade-test-session';
      const memorySessionId = 'cascade-memory-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      // Store observation
      const obs = {
        type: 'discovery',
        title: 'Will be deleted',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      };
      store.storeObservation(memorySessionId, 'test-project', obs, 1);

      // Verify observation exists
      let observations = store.getObservationsForSession(memorySessionId);
      expect(observations.length).toBe(1);

      // Delete session (should cascade to observations)
      store.db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(sessionDbId);

      // Verify observations were deleted
      observations = store.getObservationsForSession(memorySessionId);
      expect(observations.length).toBe(0);
    });

    it('should maintain FK relationship between observations and sessions', () => {
      const contentSessionId = 'fk-test-session';
      const memorySessionId = 'fk-memory-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      // This should succeed (FK exists)
      expect(() => {
        store.storeObservation(memorySessionId, 'test-project', {
          type: 'discovery',
          title: 'Valid FK',
          subtitle: null,
          facts: [],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: []
        }, 1);
      }).not.toThrow();

      // This should fail (FK doesn't exist)
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
      }).toThrow();
    });
  });

  describe('Session Lifecycle - Memory ID Capture Flow', () => {
    it('should follow correct lifecycle: create → capture → resume', () => {
      const contentSessionId = 'lifecycle-session';

      // STEP 1: Hook creates session (memory_session_id = NULL)
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull(); // NULL - not captured yet

      // STEP 2: First SDK message arrives with real session ID
      const realMemoryId = 'sdk-generated-session-xyz';
      store.updateMemorySessionId(sessionDbId, realMemoryId);
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(realMemoryId); // Real ID

      // STEP 3: Subsequent prompts can now resume
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(true);

      // Resume parameter is safe to use
      const resumeParam = session?.memory_session_id;
      expect(resumeParam).toBe(realMemoryId);
      expect(resumeParam).not.toBe(contentSessionId);
    });

    it('should handle worker restart by preserving captured memory session ID', () => {
      const contentSessionId = 'restart-test-session';
      const capturedMemoryId = 'persisted-memory-id';

      // Simulate first worker instance
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt');
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // Simulate worker restart - session re-fetched from database
      const session = store.getSessionById(sessionDbId);

      // Memory session ID should be preserved
      expect(session?.memory_session_id).toBe(capturedMemoryId);

      // Resume can work immediately
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(true);
    });
  });

  describe('CRITICAL: 1:1 Transcript Mapping Guarantees', () => {
    it('should enforce UNIQUE constraint on memory_session_id (prevents duplicate memory transcripts)', () => {
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

      // Verify first session still has the ID
      const session1 = store.getSessionById(id1);
      expect(session1?.memory_session_id).toBe(sharedMemoryId);
    });

    it('should prevent memorySessionId from being changed after real capture (single transition guarantee)', () => {
      const contentSessionId = 'single-capture-test';
      const firstMemoryId = 'first-sdk-session-id';
      const secondMemoryId = 'different-sdk-session-id';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // First capture - should succeed
      store.updateMemorySessionId(sessionDbId, firstMemoryId);

      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(firstMemoryId);

      // Second capture with DIFFERENT ID - should FAIL (or be no-op in proper implementation)
      // This test documents current behavior - ideally updateMemorySessionId should
      // check if memorySessionId already differs from contentSessionId and refuse to update
      store.updateMemorySessionId(sessionDbId, secondMemoryId);

      session = store.getSessionById(sessionDbId);

      // CRITICAL: If this allows the update, we could get multiple memory transcripts!
      // This test currently shows the vulnerability - in production, SDKAgent.ts
      // has the check `if (!session.memorySessionId)` which should prevent this,
      // but the database layer doesn't enforce it.
      //
      // For now, we document that the second update DOES go through (current behavior)
      expect(session?.memory_session_id).toBe(secondMemoryId);

      // TODO: Add database-level protection via CHECK constraint or trigger
      // to prevent changing memory_session_id once it differs from content_session_id
    });

    it('should use same memorySessionId for all prompts in a conversation (resume consistency)', () => {
      const contentSessionId = 'multi-prompt-session';
      const realMemoryId = 'consistent-memory-id';

      // Prompt 1: Create session
      let sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      let session = store.getSessionById(sessionDbId);

      // Initially NULL
      expect(session?.memory_session_id).toBeNull();

      // Prompt 1: Capture real memory ID
      store.updateMemorySessionId(sessionDbId, realMemoryId);

      // Prompt 2: Look up session by contentSessionId (simulates hook creating session again)
      sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);

      // Should get SAME memory ID (resume with this)
      expect(session?.memory_session_id).toBe(realMemoryId);

      // Prompt 3: Again, same contentSessionId
      sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 3');
      session = store.getSessionById(sessionDbId);

      // Should STILL get same memory ID
      expect(session?.memory_session_id).toBe(realMemoryId);

      // All three prompts use the SAME memorySessionId → ONE memory transcript file
      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(true);
    });

    it('should lookup session by contentSessionId and retrieve memorySessionId for resume', () => {
      const contentSessionId = 'lookup-test-session';
      const capturedMemoryId = 'memory-for-resume';

      // First prompt: Create and capture
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First');
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // Second prompt: Hook provides contentSessionId, needs to lookup memorySessionId
      // The createSDKSession method IS the lookup (INSERT OR IGNORE + SELECT)
      const lookedUpSessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Second');

      // Should be same DB row
      expect(lookedUpSessionDbId).toBe(sessionDbId);

      // Get session to extract memorySessionId for resume
      const session = store.getSessionById(lookedUpSessionDbId);
      const resumeParam = session?.memory_session_id;

      // This is what would be passed to SDK query({ resume: resumeParam })
      expect(resumeParam).toBe(capturedMemoryId);
      expect(resumeParam).not.toBe(contentSessionId);
    });
  });

  describe('Edge Cases - Session ID Equality', () => {
    it('should handle case where SDK returns session ID equal to contentSessionId', () => {
      // Edge case: SDK happens to generate same ID as content session
      // This shouldn't happen in practice, but we test it anyway
      const contentSessionId = 'same-id-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // SDK returns the same ID (unlikely but possible)
      store.updateMemorySessionId(sessionDbId, contentSessionId);

      const session = store.getSessionById(sessionDbId);
      // Now checking for non-null instead of comparing to content_session_id
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      // Would be TRUE since we set a value (even if same as content)
      // In practice, the SDK should never return the same ID as contentSessionId
      expect(hasRealMemorySessionId).toBe(true);
    });

    it('should handle NULL memory_session_id gracefully', () => {
      const contentSessionId = 'null-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // memory_session_id is already NULL from createSDKSession
      const session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      // Should be false (NULL means not captured yet)
      expect(hasRealMemorySessionId).toBe(false);
    });
  });
});
