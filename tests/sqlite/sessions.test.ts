/**
 * Session module tests
 * Tests modular session functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/sessions/create.ts
 * - API patterns from src/services/sqlite/sessions/get.ts
 * - Test pattern from tests/session_store.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  createSDKSession,
  getSessionById,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';

describe('Sessions Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  describe('createSDKSession', () => {
    it('should create a new session and return numeric ID', () => {
      const contentSessionId = 'content-session-123';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId = createSDKSession(db, contentSessionId, project, userPrompt);

      expect(typeof sessionId).toBe('number');
      expect(sessionId).toBeGreaterThan(0);
    });

    it('should be idempotent - return same ID for same content_session_id', () => {
      const contentSessionId = 'content-session-456';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId1 = createSDKSession(db, contentSessionId, project, userPrompt);
      const sessionId2 = createSDKSession(db, contentSessionId, project, 'Different prompt');

      expect(sessionId1).toBe(sessionId2);
    });

    it('should create different sessions for different content_session_ids', () => {
      const sessionId1 = createSDKSession(db, 'session-a', 'project', 'prompt');
      const sessionId2 = createSDKSession(db, 'session-b', 'project', 'prompt');

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('getSessionById', () => {
    it('should retrieve session by ID', () => {
      const contentSessionId = 'content-session-get';
      const project = 'test-project';
      const userPrompt = 'Test prompt';

      const sessionId = createSDKSession(db, contentSessionId, project, userPrompt);
      const session = getSessionById(db, sessionId);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
      expect(session?.content_session_id).toBe(contentSessionId);
      expect(session?.project).toBe(project);
      expect(session?.user_prompt).toBe(userPrompt);
      // memory_session_id should be null initially (set via updateMemorySessionId)
      expect(session?.memory_session_id).toBeNull();
    });

    it('should return null for non-existent session', () => {
      const session = getSessionById(db, 99999);

      expect(session).toBeNull();
    });
  });

  describe('updateMemorySessionId', () => {
    it('should update memory_session_id for existing session', () => {
      const contentSessionId = 'content-session-update';
      const project = 'test-project';
      const userPrompt = 'Test prompt';
      const memorySessionId = 'memory-session-abc123';

      const sessionId = createSDKSession(db, contentSessionId, project, userPrompt);

      // Verify memory_session_id is null initially
      let session = getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBeNull();

      // Update memory session ID
      updateMemorySessionId(db, sessionId, memorySessionId);

      // Verify update
      session = getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe(memorySessionId);
    });

    it('should allow updating to different memory_session_id', () => {
      const sessionId = createSDKSession(db, 'session-x', 'project', 'prompt');

      updateMemorySessionId(db, sessionId, 'memory-1');
      let session = getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe('memory-1');

      updateMemorySessionId(db, sessionId, 'memory-2');
      session = getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe('memory-2');
    });
  });
});
