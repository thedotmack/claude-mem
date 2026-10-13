import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MAX_STORED_PROMPT_CHARS } from '../../src/services/sqlite/prompt-storage.js';

describe('SessionStore prompts', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function createSession(contentSessionId: string): string {
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    return contentSessionId;
  }

  describe('saveUserPrompt', () => {
    it('returns a positive id', () => {
      const session = createSession('content-prompt-1');
      const id = store.saveUserPrompt(session, 1, 'First user prompt');
      expect(id).toBeGreaterThan(0);
    });

    it('returns incrementing ids', () => {
      const session = createSession('content-prompt-2');
      const id1 = store.saveUserPrompt(session, 1, 'First prompt');
      const id2 = store.saveUserPrompt(session, 2, 'Second prompt');
      const id3 = store.saveUserPrompt(session, 3, 'Third prompt');
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('returns distinct ids across sessions', () => {
      const a = createSession('session-a');
      const b = createSession('session-b');
      const id1 = store.saveUserPrompt(a, 1, 'Prompt A1');
      const id2 = store.saveUserPrompt(b, 1, 'Prompt B1');
      expect(id1).not.toBe(id2);
    });

    it('stores a tag-stripped, bounded prompt_text ending in an ellipsis', () => {
      const session = createSession('content-normalized');
      const oversized = `<claude-mem-context>ignored</claude-mem-context>${'A'.repeat(MAX_STORED_PROMPT_CHARS + 250)}`;

      const id = store.saveUserPrompt(session, 1, oversized);
      const stored = store.db.prepare('SELECT prompt_text FROM user_prompts WHERE id = ?').get(id) as { prompt_text: string };

      expect(stored.prompt_text.startsWith('<claude-mem-context>')).toBe(false);
      expect(stored.prompt_text.length).toBe(MAX_STORED_PROMPT_CHARS);
      expect(stored.prompt_text.endsWith('…')).toBe(true);
    });
  });

  describe('importUserPrompt', () => {
    it('uses platform context when raw content_session_id overlaps', () => {
      const contentSessionId = 'shared-import-content-id';
      const claudeSessionDbId = store.createSDKSession(contentSessionId, 'claude-project', 'claude prompt', undefined, 'claude');
      const cursorSessionDbId = store.createSDKSession(contentSessionId, 'cursor-project', 'cursor prompt', undefined, 'cursor');
      const createdAt = new Date().toISOString();

      const cursorImport = store.importUserPrompt({
        content_session_id: contentSessionId,
        platform_source: 'cursor',
        prompt_number: 1,
        prompt_text: 'cursor imported prompt',
        created_at: createdAt,
        created_at_epoch: 1,
      });
      const claudeImport = store.importUserPrompt({
        content_session_id: contentSessionId,
        platform_source: 'claude',
        prompt_number: 1,
        prompt_text: 'claude imported prompt',
        created_at: createdAt,
        created_at_epoch: 2,
      });
      const cursorDuplicate = store.importUserPrompt({
        content_session_id: contentSessionId,
        platform_source: 'cursor',
        prompt_number: 1,
        prompt_text: 'cursor duplicate prompt',
        created_at: createdAt,
        created_at_epoch: 3,
      });

      expect(cursorImport.imported).toBe(true);
      expect(claudeImport.imported).toBe(true);
      expect(cursorDuplicate.imported).toBe(false);
      expect(cursorDuplicate.id).toBe(cursorImport.id);

      const rows = store.db.prepare(`
        SELECT up.prompt_text, up.session_db_id, s.platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        WHERE up.content_session_id = ?
        ORDER BY s.platform_source
      `).all(contentSessionId) as Array<{ prompt_text: string; session_db_id: number; platform_source: string }>;

      expect(rows).toEqual([
        { prompt_text: 'claude imported prompt', session_db_id: claudeSessionDbId, platform_source: 'claude' },
        { prompt_text: 'cursor imported prompt', session_db_id: cursorSessionDbId, platform_source: 'cursor' },
      ]);
    });
  });

  describe('findRecentDuplicateUserPrompt', () => {
    it('finds a duplicate within the window', () => {
      const session = createSession('duplicate-prompt-session');
      const id = store.saveUserPrompt(session, 1, 'Repeated prompt');

      const duplicate = store.findRecentDuplicateUserPrompt(session, 'Repeated prompt', 10_000);

      expect(duplicate?.id).toBe(id);
      expect(duplicate?.prompt_number).toBe(1);
      expect(duplicate?.prompt_text).toBe('Repeated prompt');
    });
  });

  describe('getPromptNumberFromUserPrompts', () => {
    it('returns 0 when none exist', () => {
      expect(store.getPromptNumberFromUserPrompts('nonexistent-session')).toBe(0);
    });

    it('counts prompts for the session', () => {
      const session = createSession('count-test-session');
      expect(store.getPromptNumberFromUserPrompts(session)).toBe(0);
      store.saveUserPrompt(session, 1, 'First prompt');
      expect(store.getPromptNumberFromUserPrompts(session)).toBe(1);
      store.saveUserPrompt(session, 2, 'Second prompt');
      expect(store.getPromptNumberFromUserPrompts(session)).toBe(2);
    });

    it('is session-isolated', () => {
      const a = createSession('isolation-session-a');
      const b = createSession('isolation-session-b');
      store.saveUserPrompt(a, 1, 'A1');
      store.saveUserPrompt(a, 2, 'A2');
      store.saveUserPrompt(b, 1, 'B1');

      expect(store.getPromptNumberFromUserPrompts(a)).toBe(2);
      expect(store.getPromptNumberFromUserPrompts(b)).toBe(1);
    });

    it('handles many prompts', () => {
      const session = createSession('many-prompts-session');
      for (let i = 1; i <= 100; i++) {
        store.saveUserPrompt(session, i, `Prompt ${i}`);
      }
      expect(store.getPromptNumberFromUserPrompts(session)).toBe(100);
    });
  });

  describe('getLatestPromptTextFromUserPrompts', () => {
    it('returns null when none exist', () => {
      expect(store.getLatestPromptTextFromUserPrompts('nonexistent-session')).toBeNull();
    });

    it('returns the latest non-empty prompt_text by prompt_number', () => {
      const session = createSession('latest-prompt-session');
      store.saveUserPrompt(session, 1, 'prompt1');
      store.saveUserPrompt(session, 11, 'prompt11');

      expect(store.getLatestPromptTextFromUserPrompts(session)).toBe('prompt11');
    });

    it('skips empty prompt_text and returns the previous non-empty row', () => {
      const session = createSession('latest-empty-prompt-session');
      const sessionDbId = (store.db.prepare(
        'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
      ).get(session) as { id: number }).id;
      store.saveUserPrompt(session, 1, 'prompt1', sessionDbId);
      store.db.prepare(`
        INSERT INTO user_prompts
        (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionDbId, session, 12, '   ', new Date().toISOString(), Date.now());

      expect(store.getLatestPromptTextFromUserPrompts(session, sessionDbId)).toBe('prompt1');
    });

    it('is session-isolated when the same content_session_id is shared', () => {
      const contentSessionId = 'shared-latest-content-id';
      const claudeId = store.createSDKSession(contentSessionId, 'claude-project', 'prompt1', undefined, 'claude');
      const cursorId = store.createSDKSession(contentSessionId, 'cursor-project', 'cursor first', undefined, 'cursor');
      store.saveUserPrompt(contentSessionId, 1, 'claude prompt1', claudeId);
      store.saveUserPrompt(contentSessionId, 11, 'claude prompt11', claudeId);
      store.saveUserPrompt(contentSessionId, 1, 'cursor prompt1', cursorId);

      expect(store.getLatestPromptTextFromUserPrompts(contentSessionId, claudeId)).toBe('claude prompt11');
      expect(store.getLatestPromptTextFromUserPrompts(contentSessionId, cursorId)).toBe('cursor prompt1');
    });
  });
});
