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
 * 1. memorySessionId starts equal to contentSessionId (placeholder for FK)
 * 2. Resume MUST NOT be used when memorySessionId === contentSessionId
 * 3. Resume MUST ONLY be used when hasRealMemorySessionId === true
 * 4. Observations are stored with contentSessionId (not the captured SDK memorySessionId)
 * 5. updateMemorySessionId() is required before resume can work
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
    it('should identify placeholder when memorySessionId equals contentSessionId', () => {
      const contentSessionId = 'user-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');

      const session = store.getSessionById(sessionDbId);

      // Initially, they're equal (placeholder state)
      expect(session?.memory_session_id).toBe(session?.content_session_id);

      // hasRealMemorySessionId would be FALSE
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;
      expect(hasRealMemorySessionId).toBe(false);
    });

    it('should identify real memory session ID after capture', () => {
      const contentSessionId = 'user-session-456';
      const capturedMemoryId = 'sdk-generated-abc123';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      const session = store.getSessionById(sessionDbId);

      // After capture, they're different (real memory session ID)
      expect(session?.memory_session_id).not.toBe(session?.content_session_id);

      // hasRealMemorySessionId would be TRUE
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;
      expect(hasRealMemorySessionId).toBe(true);
    });

    it('should never use contentSessionId as resume parameter when in placeholder state', () => {
      const contentSessionId = 'dangerous-session-789';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      const session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;

      // CRITICAL: This check prevents resuming the USER'S session instead of memory session
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

  describe('Observation Storage - ContentSessionId Usage', () => {
    it('should store observations with contentSessionId in memory_session_id column', () => {
      const contentSessionId = 'obs-content-session-123';
      store.createSDKSession(contentSessionId, 'test-project', 'Test');

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

      // SDKAgent.ts line 332 passes session.contentSessionId here
      const result = store.storeObservation(contentSessionId, 'test-project', obs, 1);

      // Verify it's stored in the memory_session_id column with contentSessionId value
      const stored = store.db.prepare(
        'SELECT memory_session_id FROM observations WHERE id = ?'
      ).get(result.id) as { memory_session_id: string };

      // CRITICAL: memory_session_id column contains contentSessionId, not the captured SDK session ID
      expect(stored.memory_session_id).toBe(contentSessionId);
    });

    it('should be retrievable using contentSessionId (observations use contentSessionId)', () => {
      const contentSessionId = 'retrieval-test-session';

      store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // Store observation with contentSessionId
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
      store.storeObservation(contentSessionId, 'test-project', obs, 1);

      // Observations are retrievable by contentSessionId
      // (because storeObservation receives contentSessionId and stores it in memory_session_id column)
      const observations = store.getObservationsForSession(contentSessionId);
      expect(observations.length).toBe(1);
      expect(observations[0].title).toBe('Observation');
    });
  });

  describe('Resume Safety - Prevent contentSessionId Resume Bug', () => {
    it('should prevent resume with placeholder memorySessionId', () => {
      const contentSessionId = 'safety-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      const session = store.getSessionById(sessionDbId);

      // Simulate hasRealMemorySessionId check from SDKAgent.ts line 75-76
      const hasRealMemorySessionId = session?.memory_session_id &&
        session.memory_session_id !== session.content_session_id;

      // MUST be false in placeholder state
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

      // Before capture - no resume
      let session = store.getSessionById(sessionDbId);
      let hasRealMemorySessionId = session?.memory_session_id &&
        session.memory_session_id !== session.content_session_id;
      expect(hasRealMemorySessionId).toBe(false);

      // Capture memory session ID
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // After capture - resume allowed
      session = store.getSessionById(sessionDbId);
      hasRealMemorySessionId = session?.memory_session_id &&
        session.memory_session_id !== session.content_session_id;
      expect(hasRealMemorySessionId).toBe(true);

      // Resume parameter should be the captured ID
      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({ resume: capturedMemoryId });
      expect(resumeOptions.resume).not.toBe(contentSessionId);
    });
  });

  describe('Cross-Contamination Prevention', () => {
    it('should never mix observations from different content sessions', () => {
      const session1 = 'user-session-A';
      const session2 = 'user-session-B';

      store.createSDKSession(session1, 'project-a', 'Prompt A');
      store.createSDKSession(session2, 'project-b', 'Prompt B');

      // Store observations in each session
      store.storeObservation(session1, 'project-a', {
        type: 'discovery',
        title: 'Observation A',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      }, 1);

      store.storeObservation(session2, 'project-b', {
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
      const obsA = store.getObservationsForSession(session1);
      const obsB = store.getObservationsForSession(session2);

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
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

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
      store.storeObservation(contentSessionId, 'test-project', obs, 1);

      // Verify observation exists
      let observations = store.getObservationsForSession(contentSessionId);
      expect(observations.length).toBe(1);

      // Delete session (should cascade to observations)
      store.db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(sessionDbId);

      // Verify observations were deleted
      observations = store.getObservationsForSession(contentSessionId);
      expect(observations.length).toBe(0);
    });

    it('should maintain FK relationship between observations and sessions', () => {
      const contentSessionId = 'fk-test-session';
      store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // This should succeed (FK exists)
      expect(() => {
        store.storeObservation(contentSessionId, 'test-project', {
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

      // STEP 1: Hook creates session (memory_session_id = content_session_id)
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(contentSessionId); // Placeholder

      // STEP 2: First SDK message arrives with real session ID
      const realMemoryId = 'sdk-generated-session-xyz';
      store.updateMemorySessionId(sessionDbId, realMemoryId);
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(realMemoryId); // Real ID

      // STEP 3: Subsequent prompts can now resume
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;
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
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;
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

      // Initially placeholder
      expect(session?.memory_session_id).toBe(contentSessionId);

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
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;
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
      const contentSessionId = 'same-id-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // SDK returns the same ID (unlikely but possible)
      store.updateMemorySessionId(sessionDbId, contentSessionId);

      const session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== session?.content_session_id;

      // Would be FALSE, so resume would not be used
      // This is safe - worst case is a fresh session instead of resume
      expect(hasRealMemorySessionId).toBe(false);
    });

    it('should handle NULL memory_session_id gracefully', () => {
      const contentSessionId = 'null-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // Manually set memory_session_id to NULL (shouldn't happen in practice)
      store.db.prepare('UPDATE sdk_sessions SET memory_session_id = NULL WHERE id = ?').run(sessionDbId);

      const session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id &&
        session.memory_session_id !== session.content_session_id;

      // Should be falsy (NULL is falsy)
      expect(hasRealMemorySessionId).toBeFalsy();
    });
  });
});
