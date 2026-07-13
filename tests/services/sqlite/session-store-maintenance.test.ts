import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyLegacyPromptBloatMaintenance,
  LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION,
} from '../../../src/services/sqlite/maintenance.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { MAX_STORED_PROMPT_CHARS } from '../../../src/services/sqlite/prompt-storage.js';

describe('applyLegacyPromptBloatMaintenance', () => {
  let tempDir: string;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-maint-'));
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    try {
      rmSync(tempDir, { force: true, recursive: true });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EBUSY')) {
        throw error;
      }
    }
  });

  function createLegacyPrompt(payloadCharCount: number): string {
    return `<claude-mem-context>hidden</claude-mem-context>${'A'.repeat(payloadCharCount)}`;
  }

  function createFileDb(name: string): Database {
    return new Database(join(tempDir, name), { create: true, readwrite: true });
  }

  it('normalizes legacy prompt rows and clears only duplicate completed-session prompts', () => {
    const db = createFileDb('legacy-prompt-bloat.sqlite');
    db.run('PRAGMA foreign_keys = ON');

    const legacyStore = new SessionStore(db);
    cleanup = () => legacyStore.close();
    for (const version of [35, 40]) {
      expect(db.prepare('SELECT 1 FROM schema_versions WHERE version = ?').get(version)).toBeTruthy();
    }
    const completedSessionId = legacyStore.createSDKSession('completed-session', 'project', createLegacyPrompt(40_000));
    legacyStore.saveUserPrompt('completed-session', 1, 'placeholder');
    const activeSessionId = legacyStore.createSDKSession('active-session', 'project', createLegacyPrompt(40_000));
    legacyStore.saveUserPrompt('active-session', 1, createLegacyPrompt(40_000));
    const fallbackSessionId = legacyStore.createSDKSession('fallback-session', 'project', 'fallback prompt');
    const partialHistorySessionId = legacyStore.createSDKSession('partial-history-session', 'project', 'first prompt fallback');
    legacyStore.saveUserPrompt('partial-history-session', 2, 'follow-up prompt');

    db.prepare('DELETE FROM schema_versions WHERE version = ?').run(LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION);
    expect(db.prepare('SELECT version FROM schema_versions WHERE version IN (35, 40) ORDER BY version').all())
      .toEqual([{ version: 35 }, { version: 40 }]);
    db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ?, completed_at = ?, completed_at_epoch = ? WHERE id = ?')
      .run('completed', createLegacyPrompt(40_000), new Date().toISOString(), Date.now(), completedSessionId);
    db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ?, completed_at = ?, completed_at_epoch = ? WHERE id = ?')
      .run('completed', 'fallback prompt', new Date().toISOString(), Date.now(), fallbackSessionId);
    db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ?, completed_at = ?, completed_at_epoch = ? WHERE id = ?')
      .run('completed', 'first prompt fallback', new Date().toISOString(), Date.now(), partialHistorySessionId);
    db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE content_session_id = ?')
      .run(createLegacyPrompt(40_000), 'completed-session');
    db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE content_session_id = ?')
      .run(createLegacyPrompt(40_000), 'active-session');

    const result = applyLegacyPromptBloatMaintenance(db, Number.MAX_SAFE_INTEGER);

    const completed = db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(completedSessionId) as { user_prompt: string | null };
    const active = db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(activeSessionId) as { user_prompt: string | null };
    const fallback = db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(fallbackSessionId) as { user_prompt: string | null };
    const partialHistory = db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(partialHistorySessionId) as { user_prompt: string | null };
    const prompts = db.prepare(`
      SELECT content_session_id, prompt_text
      FROM user_prompts
      WHERE content_session_id IN ('completed-session', 'active-session')
      ORDER BY content_session_id
    `).all() as Array<{ content_session_id: string; prompt_text: string }>;
    const applied = db.prepare('SELECT 1 FROM schema_versions WHERE version = ?').get(
      LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION
    );

    expect(result.normalizedPromptRows).toBe(2);
    expect(result.clearedSessionPrompts).toBe(1);
    expect(completed.user_prompt).toBeNull();
    expect(active.user_prompt).not.toBeNull();
    expect(active.user_prompt?.length).toBe(MAX_STORED_PROMPT_CHARS);
    expect(active.user_prompt?.startsWith('<claude-mem-context>')).toBe(false);
    expect(fallback.user_prompt).toBe('fallback prompt');
    expect(partialHistory.user_prompt).toBe('first prompt fallback');
    expect(prompts.every(prompt => prompt.prompt_text.length === MAX_STORED_PROMPT_CHARS)).toBe(true);
    expect(prompts.every(prompt => prompt.prompt_text.startsWith('<claude-mem-context>'))).toBe(false);
    expect(applied).toBeTruthy();
  });

  it('runs bounded page reclamation after real prompt cleanup when free pages exceed the threshold', () => {
    const db = createFileDb('legacy-prompt-vacuum.sqlite');
    db.run('PRAGMA auto_vacuum = INCREMENTAL');
    db.run('VACUUM');
    db.run('PRAGMA foreign_keys = ON');

    const store = new SessionStore(db);
    cleanup = () => store.close();
    const contentSessionId = 'vacuum-session';
    const sessionId = store.createSDKSession(contentSessionId, 'project', createLegacyPrompt(300_000));
    store.saveUserPrompt(contentSessionId, 1, createLegacyPrompt(300_000));

    db.prepare('DELETE FROM schema_versions WHERE version = ?').run(LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION);
    db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ?, completed_at = ?, completed_at_epoch = ? WHERE id = ?')
      .run('completed', createLegacyPrompt(300_000), new Date().toISOString(), Date.now(), sessionId);
    db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE content_session_id = ?')
      .run(createLegacyPrompt(300_000), contentSessionId);

    const result = applyLegacyPromptBloatMaintenance(db, 1);

    expect(result.normalizedPromptRows).toBe(1);
    expect(result.clearedSessionPrompts).toBe(1);
    expect(result.compaction.mode).toBe('incremental_vacuum');
    expect(result.compaction.freeBytesBefore).toBeGreaterThan(0);
    expect(result.compaction.freeBytesAfter).toBeLessThanOrEqual(result.compaction.freeBytesBefore);
  });

  it('does not fail startup maintenance when full vacuum cannot run', () => {
    const db = createFileDb('legacy-prompt-vacuum-failure.sqlite');
    db.run('PRAGMA foreign_keys = ON');

    const store = new SessionStore(db);
    cleanup = () => store.close();
    const contentSessionId = 'vacuum-failure-session';
    const sessionId = store.createSDKSession(contentSessionId, 'project', createLegacyPrompt(300_000));
    store.saveUserPrompt(contentSessionId, 1, createLegacyPrompt(300_000));

    db.prepare('DELETE FROM schema_versions WHERE version = ?').run(LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION);
    db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ?, completed_at = ?, completed_at_epoch = ? WHERE id = ?')
      .run('completed', createLegacyPrompt(300_000), new Date().toISOString(), Date.now(), sessionId);
    db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE content_session_id = ?')
      .run(createLegacyPrompt(300_000), contentSessionId);
    db.run('PRAGMA auto_vacuum = NONE');
    db.run('VACUUM');

    const originalRun = db.run.bind(db);
    const runSpy = spyOn(db, 'run').mockImplementation((sql: string, ...params: unknown[]) => {
      if (sql === 'VACUUM') {
        throw new Error('vacuum unavailable');
      }
      return originalRun(sql, ...params);
    });

    try {
      const result = applyLegacyPromptBloatMaintenance(db, 1);
      const applied = db.prepare('SELECT 1 FROM schema_versions WHERE version = ?').get(
        LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION
      );
      const completed = db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(sessionId) as { user_prompt: string | null };

      expect(result.normalizedPromptRows).toBe(1);
      expect(result.clearedSessionPrompts).toBe(1);
      expect(result.compaction.mode).toBe('failed');
      expect(result.compaction.error).toContain('vacuum unavailable');
      expect(applied).toBeTruthy();
      expect(completed.user_prompt).toBeNull();
    } finally {
      runSpy.mockRestore();
    }
  });
});
