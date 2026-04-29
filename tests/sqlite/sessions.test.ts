
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
      expect(session?.memory_session_id).toBeNull();
    });

    it('should return null for non-existent session', () => {
      const session = getSessionById(db, 99999);

      expect(session).toBeNull();
    });
  });

  describe('custom_title', () => {
    it('should store custom_title when provided at creation', () => {
      const sessionId = createSDKSession(db, 'session-title-1', 'project', 'prompt', 'My Agent');
      const session = getSessionById(db, sessionId);

      expect(session?.custom_title).toBe('My Agent');
    });

    it('should default custom_title to null when not provided', () => {
      const sessionId = createSDKSession(db, 'session-title-2', 'project', 'prompt');
      const session = getSessionById(db, sessionId);

      expect(session?.custom_title).toBeNull();
    });

    it('should backfill custom_title on idempotent call if not already set', () => {
      const sessionId = createSDKSession(db, 'session-title-3', 'project', 'prompt');
      let session = getSessionById(db, sessionId);
      expect(session?.custom_title).toBeNull();

      createSDKSession(db, 'session-title-3', 'project', 'prompt', 'Backfilled Title');
      session = getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Backfilled Title');
    });

    it('should not overwrite existing custom_title on idempotent call', () => {
      const sessionId = createSDKSession(db, 'session-title-4', 'project', 'prompt', 'Original');
      let session = getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Original');

      createSDKSession(db, 'session-title-4', 'project', 'prompt', 'Attempted Override');
      session = getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Original');
    });

    it('should handle empty string custom_title as no title', () => {
      const sessionId = createSDKSession(db, 'session-title-5', 'project', 'prompt', '');
      const session = getSessionById(db, sessionId);

      expect(session?.custom_title).toBeNull();
    });
  });

  describe('platform_source', () => {
    it('should default new sessions to claude when platformSource is omitted', () => {
      const sessionId = createSDKSession(db, 'session-platform-1', 'project', 'prompt');
      const session = getSessionById(db, sessionId);

      expect(session?.platform_source).toBe('claude');
    });

    it('should preserve a non-default platform_source for legacy callers that omit platformSource', () => {
      const sessionId = createSDKSession(db, 'session-platform-2', 'project', 'prompt', undefined, 'codex');
      let session = getSessionById(db, sessionId);
      expect(session?.platform_source).toBe('codex');

      createSDKSession(db, 'session-platform-2', 'project', 'prompt');
      session = getSessionById(db, sessionId);
      expect(session?.platform_source).toBe('codex');
    });

    it('should reject explicit platform_source conflicts for the same session', () => {
      createSDKSession(db, 'session-platform-3', 'project', 'prompt', undefined, 'codex');

      expect(() => createSDKSession(
        db,
        'session-platform-3',
        'project',
        'prompt',
        undefined,
        'claude'
      )).toThrow(/Platform source conflict/);
    });
  });

  describe('updateMemorySessionId', () => {
    it('should update memory_session_id for existing session', () => {
      const contentSessionId = 'content-session-update';
      const project = 'test-project';
      const userPrompt = 'Test prompt';
      const memorySessionId = 'memory-session-abc123';

      const sessionId = createSDKSession(db, contentSessionId, project, userPrompt);

      let session = getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBeNull();

      updateMemorySessionId(db, sessionId, memorySessionId);

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
