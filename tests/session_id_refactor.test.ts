import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

/**
 * Tests for Session ID Refactoring
 *
 * Validates the semantic renaming:
 * - claudeSessionId → contentSessionId (user's observed Claude Code session)
 * - sdkSessionId → memorySessionId (memory agent's session ID for resume)
 *
 * Also validates the memory session ID capture mechanism for resume functionality.
 */
describe('Session ID Refactor', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('Database Migration 17 - Column Renaming', () => {
    it('should have content_session_id column in sdk_sessions table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('content_session_id');
      expect(columnNames).not.toContain('claude_session_id');
    });

    it('should have memory_session_id column in sdk_sessions table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).not.toContain('sdk_session_id');
    });

    it('should have memory_session_id column in observations table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).not.toContain('sdk_session_id');
    });

    it('should have memory_session_id column in session_summaries table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(session_summaries)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).not.toContain('sdk_session_id');
    });

    it('should have content_session_id column in user_prompts table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(user_prompts)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('content_session_id');
      expect(columnNames).not.toContain('claude_session_id');
    });

    it('should have content_session_id column in pending_messages table', () => {
      const tableInfo = store.db.query('PRAGMA table_info(pending_messages)').all() as Array<{ name: string }>;
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('content_session_id');
      expect(columnNames).not.toContain('claude_session_id');
    });

    it('should record migration 17 in schema_versions', () => {
      const result = store.db.prepare(
        'SELECT version FROM schema_versions WHERE version = 17'
      ).get() as { version: number } | undefined;

      expect(result).toBeDefined();
      expect(result?.version).toBe(17);
    });
  });

  describe('createSDKSession - Session ID Initialization', () => {
    it('should create session with content_session_id set to the provided session ID', () => {
      const contentSessionId = 'user-claude-code-session-123';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');

      const session = store.db.prepare(
        'SELECT content_session_id FROM sdk_sessions WHERE id = ?'
      ).get(sessionDbId) as { content_session_id: string };

      expect(session.content_session_id).toBe(contentSessionId);
    });

    it('should create session with memory_session_id initially NULL', () => {
      const contentSessionId = 'user-session-456';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');

      const session = store.db.prepare(
        'SELECT content_session_id, memory_session_id FROM sdk_sessions WHERE id = ?'
      ).get(sessionDbId) as { content_session_id: string; memory_session_id: string | null };

      // CRITICAL: memory_session_id starts as NULL - it must NEVER equal contentSessionId
      // because that would inject memory messages into the user's transcript!
      expect(session.memory_session_id).toBeNull();
    });

    it('should be idempotent - return same ID for same content_session_id', () => {
      const contentSessionId = 'idempotent-test-session';

      const id1 = store.createSDKSession(contentSessionId, 'project-1', 'First prompt');
      const id2 = store.createSDKSession(contentSessionId, 'project-2', 'Second prompt');

      expect(id1).toBe(id2);

      // Verify the original values are preserved (INSERT OR IGNORE)
      const session = store.db.prepare(
        'SELECT project, user_prompt FROM sdk_sessions WHERE id = ?'
      ).get(id1) as { project: string; user_prompt: string };

      expect(session.project).toBe('project-1');
      expect(session.user_prompt).toBe('First prompt');
    });
  });

  describe('updateMemorySessionId - Memory Agent Session Capture', () => {
    it('should update memory_session_id for existing session', () => {
      const contentSessionId = 'content-session-789';
      const memorySessionId = 'sdk-generated-memory-session-abc';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // Initially memory_session_id is NULL
      const beforeUpdate = store.db.prepare(
        'SELECT memory_session_id FROM sdk_sessions WHERE id = ?'
      ).get(sessionDbId) as { memory_session_id: string | null };
      expect(beforeUpdate.memory_session_id).toBeNull();

      // Update with SDK-captured memory session ID
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      // Verify it was updated
      const afterUpdate = store.db.prepare(
        'SELECT memory_session_id FROM sdk_sessions WHERE id = ?'
      ).get(sessionDbId) as { memory_session_id: string };
      expect(afterUpdate.memory_session_id).toBe(memorySessionId);
    });

    it('should allow updating memory_session_id multiple times', () => {
      const contentSessionId = 'multi-update-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      store.updateMemorySessionId(sessionDbId, 'first-memory-id');
      store.updateMemorySessionId(sessionDbId, 'second-memory-id');

      const session = store.db.prepare(
        'SELECT memory_session_id FROM sdk_sessions WHERE id = ?'
      ).get(sessionDbId) as { memory_session_id: string };

      expect(session.memory_session_id).toBe('second-memory-id');
    });
  });

  describe('getSessionById - Session Retrieval', () => {
    it('should return session with both content_session_id and memory_session_id', () => {
      const contentSessionId = 'retrieve-test-session';
      const memorySessionId = 'captured-memory-id';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test prompt');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const session = store.getSessionById(sessionDbId);

      expect(session).not.toBeNull();
      expect(session?.content_session_id).toBe(contentSessionId);
      expect(session?.memory_session_id).toBe(memorySessionId);
    });

    it('should initialize memory_session_id to NULL before SDK capture', () => {
      const contentSessionId = 'never-captured-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');

      // createSDKSession sets memory_session_id = NULL initially
      // The memory_session_id gets set when SDK responds with its session ID
      const session = store.getSessionById(sessionDbId);
      expect(session?.memory_session_id).toBeNull();
    });
  });

  describe('storeObservation - Memory Session ID Reference', () => {
    it('should store observation with memory_session_id as foreign key', () => {
      const contentSessionId = 'obs-test-session';
      const memorySessionId = 'memory-obs-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const obs = {
        type: 'discovery',
        title: 'Test Observation',
        subtitle: null,
        facts: ['Fact 1'],
        narrative: 'Testing memory session ID reference',
        concepts: ['testing'],
        files_read: [],
        files_modified: []
      };

      const result = store.storeObservation(memorySessionId, 'test-project', obs, 1);

      // Verify the observation was stored with memory_session_id
      const stored = store.db.prepare(
        'SELECT memory_session_id FROM observations WHERE id = ?'
      ).get(result.id) as { memory_session_id: string };

      expect(stored.memory_session_id).toBe(memorySessionId);
    });

    it('should be retrievable by getObservationsForSession using memory_session_id', () => {
      const contentSessionId = 'obs-retrieval-session';
      const memorySessionId = 'memory-retrieval-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const obs = {
        type: 'feature',
        title: 'New Feature',
        subtitle: 'Sub',
        facts: [],
        narrative: null,
        concepts: [],
        files_read: ['file1.ts'],
        files_modified: ['file2.ts']
      };

      store.storeObservation(memorySessionId, 'test-project', obs, 1);

      const observations = store.getObservationsForSession(memorySessionId);

      expect(observations.length).toBe(1);
      expect(observations[0].title).toBe('New Feature');
    });
  });

  describe('storeSummary - Memory Session ID Reference', () => {
    it('should store summary with memory_session_id as foreign key', () => {
      const contentSessionId = 'summary-test-session';
      const memorySessionId = 'memory-summary-test-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const summary = {
        request: 'Test request',
        investigated: 'Investigated stuff',
        learned: 'Learned things',
        completed: 'Completed work',
        next_steps: 'Next steps here',
        notes: null
      };

      const result = store.storeSummary(memorySessionId, 'test-project', summary, 1);

      // Verify the summary was stored with memory_session_id
      const stored = store.db.prepare(
        'SELECT memory_session_id FROM session_summaries WHERE id = ?'
      ).get(result.id) as { memory_session_id: string };

      expect(stored.memory_session_id).toBe(memorySessionId);
    });

    it('should be retrievable by getSummaryForSession using memory_session_id', () => {
      const contentSessionId = 'summary-retrieval-session';
      const memorySessionId = 'memory-summary-retrieval-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      const summary = {
        request: 'My request',
        investigated: 'Investigation',
        learned: 'Learnings',
        completed: 'Completions',
        next_steps: 'Next',
        notes: 'Some notes'
      };

      store.storeSummary(memorySessionId, 'test-project', summary, 1);

      const retrieved = store.getSummaryForSession(memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.request).toBe('My request');
      expect(retrieved?.notes).toBe('Some notes');
    });
  });

  describe('saveUserPrompt - Content Session ID Reference', () => {
    it('should store user prompt with content_session_id as foreign key', () => {
      const contentSessionId = 'prompt-test-session';
      store.createSDKSession(contentSessionId, 'test-project', 'Initial');

      const promptId = store.saveUserPrompt(contentSessionId, 1, 'First user prompt');

      // Verify the prompt was stored with content_session_id
      const stored = store.db.prepare(
        'SELECT content_session_id FROM user_prompts WHERE id = ?'
      ).get(promptId) as { content_session_id: string };

      expect(stored.content_session_id).toBe(contentSessionId);
    });

    it('should be countable by getPromptNumberFromUserPrompts using content_session_id', () => {
      const contentSessionId = 'prompt-count-session';
      store.createSDKSession(contentSessionId, 'test-project', 'Initial');

      expect(store.getPromptNumberFromUserPrompts(contentSessionId)).toBe(0);

      store.saveUserPrompt(contentSessionId, 1, 'First');
      expect(store.getPromptNumberFromUserPrompts(contentSessionId)).toBe(1);

      store.saveUserPrompt(contentSessionId, 2, 'Second');
      expect(store.getPromptNumberFromUserPrompts(contentSessionId)).toBe(2);
    });

    it('should be retrievable by getUserPrompt using content_session_id', () => {
      const contentSessionId = 'prompt-retrieve-session';
      store.createSDKSession(contentSessionId, 'test-project', 'Initial');

      store.saveUserPrompt(contentSessionId, 1, 'Hello world');

      const retrieved = store.getUserPrompt(contentSessionId, 1);

      expect(retrieved).toBe('Hello world');
    });
  });

  describe('getLatestUserPrompt - Joined Query with Both Session IDs', () => {
    it('should return prompt with both content_session_id and memory_session_id', () => {
      const contentSessionId = 'latest-prompt-session';
      const memorySessionId = 'captured-memory-for-latest';

      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Initial');
      store.updateMemorySessionId(sessionDbId, memorySessionId);
      store.saveUserPrompt(contentSessionId, 1, 'Latest prompt text');

      const latest = store.getLatestUserPrompt(contentSessionId);

      expect(latest).toBeDefined();
      expect(latest?.content_session_id).toBe(contentSessionId);
      expect(latest?.memory_session_id).toBe(memorySessionId);
      expect(latest?.prompt_text).toBe('Latest prompt text');
    });
  });

  describe('getAllRecentUserPrompts - Joined Query with Project', () => {
    it('should return prompts with content_session_id and project from session', () => {
      const contentSessionId = 'all-prompts-session';
      store.createSDKSession(contentSessionId, 'my-project', 'Initial');
      store.saveUserPrompt(contentSessionId, 1, 'Prompt one');
      store.saveUserPrompt(contentSessionId, 2, 'Prompt two');

      const prompts = store.getAllRecentUserPrompts(10);

      expect(prompts.length).toBe(2);
      expect(prompts[0].content_session_id).toBe(contentSessionId);
      expect(prompts[0].project).toBe('my-project');
    });
  });

  describe('Resume Functionality - Memory Session ID Usage', () => {
    it('should preserve memory_session_id across session re-initialization', () => {
      const contentSessionId = 'resume-test-session';
      const capturedMemoryId = 'sdk-memory-session-for-resume';

      // Simulate first interaction: create session, then SDK responds with session ID
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'First prompt');
      store.updateMemorySessionId(sessionDbId, capturedMemoryId);

      // Simulate worker restart or new request: fetch session from database
      const retrievedSession = store.getSessionById(sessionDbId);

      // The memory_session_id should be available for resume parameter
      expect(retrievedSession?.memory_session_id).toBe(capturedMemoryId);
    });

    it('should support multiple observations linked to same memory_session_id', () => {
      const contentSessionId = 'multi-obs-session';
      const memorySessionId = 'memory-multi-obs-session';
      const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'Test');
      store.updateMemorySessionId(sessionDbId, memorySessionId);

      // Store multiple observations
      for (let i = 1; i <= 5; i++) {
        store.storeObservation(memorySessionId, 'test-project', {
          type: 'discovery',
          title: `Observation ${i}`,
          subtitle: null,
          facts: [],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: []
        }, i);
      }

      const observations = store.getObservationsForSession(memorySessionId);
      expect(observations.length).toBe(5);

      // All should have the same memory_session_id
      const directQuery = store.db.prepare(
        'SELECT DISTINCT memory_session_id FROM observations WHERE memory_session_id = ?'
      ).all(memorySessionId) as Array<{ memory_session_id: string }>;

      expect(directQuery.length).toBe(1);
      expect(directQuery[0].memory_session_id).toBe(memorySessionId);
    });
  });
});
