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
import type { DbAdapter } from '../../src/services/sqlite/adapter.js';

describe('Sessions Module', () => {
  let db: DbAdapter;

  beforeEach(async () => {
    const cmdb = await ClaudeMemDatabase.create(':memory:');
    db = cmdb.db;
  });

  afterEach(async () => {
    await db.close();
  });

  describe('createSDKSession', () => {
    it('should create a new session and return numeric ID', async () => {
      const contentSessionId = 'content-session-123';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId = await createSDKSession(db, contentSessionId, project, userPrompt);

      expect(typeof sessionId).toBe('number');
      expect(sessionId).toBeGreaterThan(0);
    });

    it('should be idempotent - return same ID for same content_session_id', async () => {
      const contentSessionId = 'content-session-456';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId1 = await createSDKSession(db, contentSessionId, project, userPrompt);
      const sessionId2 = await createSDKSession(db, contentSessionId, project, 'Different prompt');

      expect(sessionId1).toBe(sessionId2);
    });

    it('should create different sessions for different content_session_ids', async () => {
      const sessionId1 = await createSDKSession(db, 'session-a', 'project', 'prompt');
      const sessionId2 = await createSDKSession(db, 'session-b', 'project', 'prompt');

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('getSessionById', () => {
    it('should retrieve session by ID', async () => {
      const contentSessionId = 'content-session-get';
      const project = 'test-project';
      const userPrompt = 'Test prompt';

      const sessionId = await createSDKSession(db, contentSessionId, project, userPrompt);
      const session = await getSessionById(db, sessionId);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
      expect(session?.content_session_id).toBe(contentSessionId);
      expect(session?.project).toBe(project);
      expect(session?.user_prompt).toBe(userPrompt);
      // memory_session_id should be null initially (set via updateMemorySessionId)
      expect(session?.memory_session_id).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const session = await getSessionById(db, 99999);

      expect(session).toBeNull();
    });
  });

  describe('custom_title', () => {
    it('should store custom_title when provided at creation', async () => {
      const sessionId = await createSDKSession(db, 'session-title-1', 'project', 'prompt', 'My Agent');
      const session = await getSessionById(db, sessionId);

      expect(session?.custom_title).toBe('My Agent');
    });

    it('should default custom_title to null when not provided', async () => {
      const sessionId = await createSDKSession(db, 'session-title-2', 'project', 'prompt');
      const session = await getSessionById(db, sessionId);

      expect(session?.custom_title).toBeNull();
    });

    it('should backfill custom_title on idempotent call if not already set', async () => {
      const sessionId = await createSDKSession(db, 'session-title-3', 'project', 'prompt');
      let session = await getSessionById(db, sessionId);
      expect(session?.custom_title).toBeNull();

      // Second call with custom_title should backfill
      await createSDKSession(db, 'session-title-3', 'project', 'prompt', 'Backfilled Title');
      session = await getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Backfilled Title');
    });

    it('should not overwrite existing custom_title on idempotent call', async () => {
      const sessionId = await createSDKSession(db, 'session-title-4', 'project', 'prompt', 'Original');
      let session = await getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Original');

      // Second call should NOT overwrite
      await createSDKSession(db, 'session-title-4', 'project', 'prompt', 'Attempted Override');
      session = await getSessionById(db, sessionId);
      expect(session?.custom_title).toBe('Original');
    });

    it('should handle empty string custom_title as no title', async () => {
      const sessionId = await createSDKSession(db, 'session-title-5', 'project', 'prompt', '');
      const session = await getSessionById(db, sessionId);

      // Empty string becomes null via the || null conversion
      expect(session?.custom_title).toBeNull();
    });
  });

  describe('updateMemorySessionId', () => {
    it('should update memory_session_id for existing session', async () => {
      const contentSessionId = 'content-session-update';
      const project = 'test-project';
      const userPrompt = 'Test prompt';
      const memorySessionId = 'memory-session-abc123';

      const sessionId = await createSDKSession(db, contentSessionId, project, userPrompt);

      // Verify memory_session_id is null initially
      let session = await getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBeNull();

      // Update memory session ID
      await updateMemorySessionId(db, sessionId, memorySessionId);

      // Verify update
      session = await getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe(memorySessionId);
    });

    it('should allow updating to different memory_session_id', async () => {
      const sessionId = await createSDKSession(db, 'session-x', 'project', 'prompt');

      await updateMemorySessionId(db, sessionId, 'memory-1');
      let session = await getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe('memory-1');

      await updateMemorySessionId(db, sessionId, 'memory-2');
      session = await getSessionById(db, sessionId);
      expect(session?.memory_session_id).toBe('memory-2');
    });
  });
});
