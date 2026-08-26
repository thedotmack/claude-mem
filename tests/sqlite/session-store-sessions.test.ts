import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MAX_STORED_PROMPT_CHARS } from '../../src/services/sqlite/prompt-storage.js';

describe('SessionStore session lifecycle', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('createSDKSession', () => {
    it('returns a positive id', () => {
      const id = store.createSDKSession('content-1', 'project', 'prompt');
      expect(id).toBeGreaterThan(0);
    });

    it('is idempotent for the same content_session_id', () => {
      const a = store.createSDKSession('content-same', 'project', 'prompt');
      const b = store.createSDKSession('content-same', 'project', 'different prompt');
      expect(b).toBe(a);
    });

    it('returns different ids for different content_session_ids', () => {
      const a = store.createSDKSession('content-a', 'project', 'prompt');
      const b = store.createSDKSession('content-b', 'project', 'prompt');
      expect(a).not.toBe(b);
    });

    it('persists a tag-stripped, bounded user_prompt ending in an ellipsis', () => {
      const oversized = `<private>hidden</private>${'B'.repeat(MAX_STORED_PROMPT_CHARS + 150)}`;
      const id = store.createSDKSession('content-normalized', 'project', oversized);
      const session = store.getSessionById(id);

      expect(session?.user_prompt.startsWith('<private>')).toBe(false);
      expect(session?.user_prompt.length).toBe(MAX_STORED_PROMPT_CHARS);
      expect(session?.user_prompt.endsWith('…')).toBe(true);
    });
  });

  describe('getSessionById', () => {
    it('round-trips fields and defaults memory_session_id to null', () => {
      const id = store.createSDKSession('content-get', 'test-project', 'Test prompt');
      const session = store.getSessionById(id);

      expect(session?.id).toBe(id);
      expect(session?.content_session_id).toBe('content-get');
      expect(session?.project).toBe('test-project');
      expect(session?.user_prompt).toBe('Test prompt');
      expect(session?.memory_session_id).toBeNull();
    });

    it('returns null for a missing session', () => {
      expect(store.getSessionById(99999)).toBeNull();
    });
  });

  describe('custom_title', () => {
    it('stores custom_title at creation', () => {
      const id = store.createSDKSession('content-title-1', 'project', 'prompt', 'My Agent');
      expect(store.getSessionById(id)?.custom_title).toBe('My Agent');
    });

    it('defaults custom_title to null', () => {
      const id = store.createSDKSession('content-title-2', 'project', 'prompt');
      expect(store.getSessionById(id)?.custom_title).toBeNull();
    });

    it('backfills custom_title on an idempotent call if unset', () => {
      const id = store.createSDKSession('content-title-3', 'project', 'prompt');
      expect(store.getSessionById(id)?.custom_title).toBeNull();

      store.createSDKSession('content-title-3', 'project', 'prompt', 'Backfilled Title');
      expect(store.getSessionById(id)?.custom_title).toBe('Backfilled Title');
    });

    it('does not overwrite an existing custom_title', () => {
      const id = store.createSDKSession('content-title-4', 'project', 'prompt', 'Original');
      store.createSDKSession('content-title-4', 'project', 'prompt', 'Attempted Override');
      expect(store.getSessionById(id)?.custom_title).toBe('Original');
    });

    it('treats an empty-string custom_title as null', () => {
      const id = store.createSDKSession('content-title-5', 'project', 'prompt', '');
      expect(store.getSessionById(id)?.custom_title).toBeNull();
    });
  });

  describe('platform_source', () => {
    it('defaults to claude', () => {
      const id = store.createSDKSession('content-platform-1', 'project', 'prompt');
      expect(store.getSessionById(id)?.platform_source).toBe('claude');
    });

    it('uses claude when a legacy caller omits platform_source', () => {
      const id = store.createSDKSession('content-platform-2', 'project', 'prompt', undefined, 'codex');
      expect(store.getSessionById(id)?.platform_source).toBe('codex');

      const defaultId = store.createSDKSession('content-platform-2', 'project', 'prompt');
      expect(defaultId).not.toBe(id);
      expect(store.getSessionById(defaultId)?.platform_source).toBe('claude');
    });

    it('allows the same raw content_session_id for different platform_source values', () => {
      const claudeId = store.createSDKSession('content-platform-3', 'claude-project', 'prompt', undefined, 'claude');
      const cursorId = store.createSDKSession('content-platform-3', 'cursor-project', 'prompt', undefined, 'cursor');

      expect(cursorId).not.toBe(claudeId);
      expect(store.getSessionById(claudeId)?.platform_source).toBe('claude');
      expect(store.getSessionById(cursorId)?.platform_source).toBe('cursor');
      expect(store.createSDKSession('content-platform-3', 'later', 'prompt', undefined, 'claude')).toBe(claudeId);
    });
  });

  describe('updateMemorySessionId', () => {
    it('sets and allows re-update to a different value', () => {
      const id = store.createSDKSession('content-update', 'project', 'prompt');
      expect(store.getSessionById(id)?.memory_session_id).toBeNull();

      store.updateMemorySessionId(id, 'memory-1');
      expect(store.getSessionById(id)?.memory_session_id).toBe('memory-1');

      store.updateMemorySessionId(id, 'memory-2');
      expect(store.getSessionById(id)?.memory_session_id).toBe('memory-2');
    });
  });
});
