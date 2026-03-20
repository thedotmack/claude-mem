/**
 * Prompts module tests
 * Tests modular prompt functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/prompts/store.ts
 * - API patterns from src/services/sqlite/prompts/get.ts
 * - Test pattern from tests/session_store.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  saveUserPrompt,
  getPromptNumberFromUserPrompts,
} from '../../src/services/sqlite/Prompts.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { DbAdapter } from '../../src/services/sqlite/adapter.js';

describe('Prompts Module', () => {
  let db: DbAdapter;

  beforeEach(async () => {
    const cmdb = await ClaudeMemDatabase.create(':memory:');
    db = cmdb.db;
  });

  afterEach(async () => {
    await db.close();
  });

  // Helper to create a session (for FK constraint on user_prompts.content_session_id)
  async function createSession(contentSessionId: string, project: string = 'test-project'): Promise<string> {
    await createSDKSession(db, contentSessionId, project, 'initial prompt');
    return contentSessionId;
  }

  describe('saveUserPrompt', () => {
    it('should store prompt and return numeric ID', async () => {
      const contentSessionId = await createSession('content-session-prompt-1');
      const promptNumber = 1;
      const promptText = 'First user prompt';

      const id = await saveUserPrompt(db, contentSessionId, promptNumber, promptText);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should store multiple prompts with incrementing IDs', async () => {
      const contentSessionId = await createSession('content-session-prompt-2');

      const id1 = await saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      const id2 = await saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      const id3 = await saveUserPrompt(db, contentSessionId, 3, 'Third prompt');

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('should allow prompts from different sessions', async () => {
      const sessionA = await createSession('session-a');
      const sessionB = await createSession('session-b');

      const id1 = await saveUserPrompt(db, sessionA, 1, 'Prompt A1');
      const id2 = await saveUserPrompt(db, sessionB, 1, 'Prompt B1');

      expect(id1).not.toBe(id2);
    });
  });

  describe('getPromptNumberFromUserPrompts', () => {
    it('should return 0 when no prompts exist', async () => {
      const count = await getPromptNumberFromUserPrompts(db, 'nonexistent-session');

      expect(count).toBe(0);
    });

    it('should return count of prompts for session', async () => {
      const contentSessionId = await createSession('count-test-session');

      expect(await getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(0);

      await saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      expect(await getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(1);

      await saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      expect(await getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(2);

      await saveUserPrompt(db, contentSessionId, 3, 'Third prompt');
      expect(await getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(3);
    });

    it('should maintain session isolation', async () => {
      const sessionA = await createSession('isolation-session-a');
      const sessionB = await createSession('isolation-session-b');

      // Add prompts to session A
      await saveUserPrompt(db, sessionA, 1, 'A1');
      await saveUserPrompt(db, sessionA, 2, 'A2');

      // Add prompts to session B
      await saveUserPrompt(db, sessionB, 1, 'B1');

      // Session A should have 2 prompts
      expect(await getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);

      // Session B should have 1 prompt
      expect(await getPromptNumberFromUserPrompts(db, sessionB)).toBe(1);

      // Adding to session B shouldn't affect session A
      await saveUserPrompt(db, sessionB, 2, 'B2');
      await saveUserPrompt(db, sessionB, 3, 'B3');

      expect(await getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);
      expect(await getPromptNumberFromUserPrompts(db, sessionB)).toBe(3);
    });

    it('should handle edge case of many prompts', async () => {
      const contentSessionId = await createSession('many-prompts-session');

      for (let i = 1; i <= 100; i++) {
        await saveUserPrompt(db, contentSessionId, i, `Prompt ${i}`);
      }

      expect(await getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(100);
    });
  });
});
