import { describe, expect, it } from 'bun:test';
import {
  applyLegacyPromptBloatMaintenance,
  LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION,
} from '../../../src/services/sqlite/maintenance.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { MAX_STORED_PROMPT_CHARS } from '../../../src/services/sqlite/prompt-storage.js';

function legacyPrompt(size: number): string {
  return `<claude-mem-context>hidden</claude-mem-context>${'A'.repeat(size)}`;
}

describe('applyLegacyPromptBloatMaintenance', () => {
  it('normalizes legacy prompt rows and clears only same-session completed prompt duplicates', () => {
    const store = new SessionStore(':memory:');
    try {
      const claudeSessionId = store.createSDKSession('shared-content', 'project', 'claude prompt', undefined, 'claude');
      const codexSessionId = store.createSDKSession('shared-content', 'project', 'codex prompt', undefined, 'codex');
      const claudePromptId = store.saveUserPrompt('shared-content', 1, 'placeholder', claudeSessionId);
      const codexPromptId = store.saveUserPrompt('shared-content', 2, 'placeholder', codexSessionId);

      store.db.prepare('DELETE FROM schema_versions WHERE version = ?').run(LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION);
      store.db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ? WHERE id = ?')
        .run('completed', legacyPrompt(40_000), claudeSessionId);
      store.db.prepare('UPDATE sdk_sessions SET status = ?, user_prompt = ? WHERE id = ?')
        .run('completed', legacyPrompt(40_000), codexSessionId);
      store.db.prepare('UPDATE user_prompts SET prompt_text = ? WHERE id IN (?, ?)')
        .run(legacyPrompt(40_000), claudePromptId, codexPromptId);

      const result = applyLegacyPromptBloatMaintenance(store.db, Number.MAX_SAFE_INTEGER);

      const claude = store.db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(claudeSessionId) as { user_prompt: string | null };
      const codex = store.db.prepare('SELECT user_prompt FROM sdk_sessions WHERE id = ?').get(codexSessionId) as { user_prompt: string | null };
      const prompts = store.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE id IN (?, ?)
      `).all(claudePromptId, codexPromptId) as Array<{ prompt_text: string }>;
      const applied = store.db.prepare('SELECT 1 FROM schema_versions WHERE version = ?').get(LEGACY_PROMPT_BLOAT_MAINTENANCE_VERSION);

      expect(result.versionApplied).toBe(true);
      expect(result.normalizedPromptRows).toBe(2);
      expect(result.clearedSessionPrompts).toBe(1);
      expect(claude.user_prompt).toBeNull();
      expect(codex.user_prompt).toBe(legacyPrompt(40_000));
      expect(prompts.every(prompt => prompt.prompt_text.length === MAX_STORED_PROMPT_CHARS)).toBe(true);
      expect(prompts.every(prompt => prompt.prompt_text.startsWith('<claude-mem-context>'))).toBe(false);
      expect(applied).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('is idempotent once the maintenance version is applied', () => {
    const store = new SessionStore(':memory:');
    try {
      const result = applyLegacyPromptBloatMaintenance(store.db, Number.MAX_SAFE_INTEGER);

      expect(result.versionApplied).toBe(false);
      expect(result.normalizedPromptRows).toBe(0);
      expect(result.clearedSessionPrompts).toBe(0);
      expect(result.compaction.mode).toBe('skipped');
    } finally {
      store.close();
    }
  });
});
