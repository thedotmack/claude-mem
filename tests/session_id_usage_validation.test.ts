import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

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
      const content1 = 'user-session-A';
      const content2 = 'user-session-B';
      const memory1 = 'memory-session-A';
      const memory2 = 'memory-session-B';

      const id1 = store.createSDKSession(content1, 'project-a', 'Prompt A');
      const id2 = store.createSDKSession(content2, 'project-b', 'Prompt B');
      store.updateMemorySessionId(id1, memory1);
      store.updateMemorySessionId(id2, memory2);

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

      const obsA = store.getObservationsForSession(memory1);
      const obsB = store.getObservationsForSession(memory2);

      expect(obsA.length).toBe(1);
      expect(obsB.length).toBe(1);
      expect(obsA[0].title).toBe('Observation A');
      expect(obsB[0].title).toBe('Observation B');

      expect(obsA.some(o => o.title === 'Observation B')).toBe(false);
      expect(obsB.some(o => o.title === 'Observation A')).toBe(false);
    });
  });

  describe('Resume Safety', () => {
    it('should prevent resume when memorySessionId is NULL (not yet captured)', () => {
      const contentSessionId = 'new-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');

      const session = store.getSessionById(sessionDbId);

      expect(session?.memory_session_id).toBeNull();

      const hasRealMemorySessionId = session?.memory_session_id !== null;
      expect(hasRealMemorySessionId).toBe(false);

      const resumeOptions = hasRealMemorySessionId ? { resume: session?.memory_session_id } : {};
      expect(resumeOptions).toEqual({});
    });

    it('should allow resume only after memorySessionId is captured', () => {
      const contentSessionId = 'resume-ready-session';
      const capturedMemoryId = 'sdk-returned-session-xyz';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt');

      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();

      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      session = store.getSessionById(sessionDbId);
      const hasRealMemorySessionId = session?.memory_session_id !== null;

      expect(hasRealMemorySessionId).toBe(true);
      expect(session?.memory_session_id).toBe(capturedMemoryId);
      expect(session?.memory_session_id).not.toBe(contentSessionId);
    });

    it('should preserve memorySessionId across createSDKSession calls (pure get-or-create)', () => {
      const contentSessionId = 'multi-prompt-session';
      const firstMemoryId = 'first-generator-memory-id';

      let sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      store.updateMemorySessionId(sessionDbId, firstMemoryId);
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(firstMemoryId);

      sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 2');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe(firstMemoryId); 

      store.ensureMemorySessionIdRegistered(sessionDbId, 'second-generator-memory-id');
      session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBe('second-generator-memory-id');
    });

    it('should NOT reset memorySessionId when it is still NULL (first prompt scenario)', () => {
      const contentSessionId = 'new-session';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Prompt 1');
      let session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();

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

      store.updateMemorySessionId(id1, sharedMemoryId);

      expect(() => {
        store.updateMemorySessionId(id2, sharedMemoryId);
      }).toThrow(); 

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
      }).toThrow(); 
    });
  });
});
