import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('native prompt receipts', () => {
  it('migrates an existing prompt table and survives an abrupt process exit after claiming a receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-native-exit-'));
    const db = join(dir, 'db.sqlite');
    let store = new SessionStore(db, { syncOpsEnabled: false });
    try {
      const sid = store.createSDKSession('old-session', 'project', 'legacy', undefined, 'hermes');
      store.saveUserPrompt('old-session', 1, 'legacy', sid);
      store.db.run('DROP INDEX idx_user_prompts_native_identity');
      store.db.run('ALTER TABLE user_prompts DROP COLUMN native_prompt_id');
      store.db.run('ALTER TABLE user_prompts DROP COLUMN native_prompt_hash');
      store.close();
      const module = new URL('../../src/services/sqlite/SessionStore.ts', import.meta.url).href;
      const code = `const { SessionStore } = await import(${JSON.stringify(module)});
        const store = new SessionStore(process.env.CMEM_NATIVE_EXIT_DB, { syncOpsEnabled: false });
        const sid = store.createSDKSession('old-session', 'project', 'again', undefined, 'hermes');
        const receipt = store.saveNativeUserPrompt('old-session', sid, 'lost-response-turn', 'again');
        process.stdout.write(JSON.stringify(receipt)); process.exit(0);`;
      const child = Bun.spawnSync([process.execPath, '-e', code], {
        env: { ...process.env, CMEM_NATIVE_EXIT_DB: db }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(child.exitCode).toBe(0);
      const receipt = JSON.parse(child.stdout.toString());
      store = new SessionStore(db, { syncOpsEnabled: false });
      expect(store.saveNativeUserPrompt('old-session', sid, 'lost-response-turn', 'again')).toEqual({ ...receipt, duplicate: true });
      expect(store.getPromptNumberFromUserPrompts('old-session', sid)).toBe(2);
      const legacy = store.db.query('SELECT native_prompt_id, native_prompt_hash FROM user_prompts WHERE session_db_id = ? AND prompt_number = 1').get(sid);
      expect(legacy).toEqual({ native_prompt_id: null, native_prompt_hash: null });
      expect(store.getUserPrompt('old-session', 1, sid)).toBe('legacy');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps repeated real turns distinct and returns the same receipt after a lost response/restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-native-prompt-'));
    let store = new SessionStore(join(dir, 'db.sqlite'), { syncOpsEnabled: false });
    try {
      const sid = store.createSDKSession('native-session', 'project', 'again', undefined, 'hermes');
      const first = store.saveNativeUserPrompt('native-session', sid, 'turn-1', 'again');
      const second = store.saveNativeUserPrompt('native-session', sid, 'turn-2', 'again');
      expect(second.id).not.toBe(first.id);
      expect(second.promptNumber).toBe(first.promptNumber + 1);
      store.close();
      store = new SessionStore(join(dir, 'db.sqlite'), { syncOpsEnabled: false });
      const retry = store.saveNativeUserPrompt('native-session', sid, 'turn-1', 'again');
      expect(retry).toEqual({ ...first, duplicate: true });
      expect(store.getPromptNumberFromUserPrompts('native-session', sid)).toBe(2);
      expect(() => store.saveNativeUserPrompt('native-session', sid, 'turn-1', 'different')).toThrow('reused with different text');
      expect(store.getPromptNumberFromUserPrompts('native-session', sid)).toBe(2);
      store.saveNativeUserPrompt('native-session', sid, 'long-ask', 'prefix'.repeat(1000) + 'first');
      expect(() => store.saveNativeUserPrompt('native-session', sid, 'long-ask', 'prefix'.repeat(1000) + 'different')).toThrow('reused with different text');
      for (const invalid of ['', 'white space', 'x'.repeat(257), 'control\u0000']) {
        expect(() => store.saveNativeUserPrompt('native-session', sid, invalid, 'again')).toThrow('Invalid native prompt');
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('scopes native IDs by session/platform, keeps old rows/imports usable, and does not reopen on a retry', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const a = store.createSDKSession('a', 'project', 'text', undefined, 'hermes');
      const b = store.createSDKSession('b', 'project', 'text', undefined, 'hermes');
      const c = store.createSDKSession('a', 'project', 'text', undefined, 'claude');
      const records = [a, b, c].map((id, i) => store.saveNativeUserPrompt(i === 1 ? 'b' : 'a', id, 'same-turn-id', 'text'));
      expect(new Set(records.map(record => record.id)).size).toBe(3);
      store.db.run("UPDATE sdk_sessions SET status = 'completed' WHERE id = ?", [a]);
      store.saveNativeUserPrompt('a', a, 'same-turn-id', 'text');
      expect(store.getSessionById(a)?.status).toBe('completed');
      store.saveNativeUserPrompt('a', a, 'next-turn-id', 'text');
      expect(store.getSessionById(a)?.status).toBe('active');
      store.saveUserPrompt('b', 2, 'legacy', b);
      expect(store.findRecentDuplicateUserPrompt('b', 'legacy', 10_000, b)?.prompt_number).toBe(2);
      const raw = store.db.query('SELECT native_prompt_id FROM user_prompts WHERE session_db_id = ? AND prompt_number = 2').get(b) as any;
      expect(raw.native_prompt_id).toBeNull();
      const imported = store.importUserPrompt({ content_session_id: 'b', prompt_number: 3, prompt_text: 'imported',
        created_at: new Date().toISOString(), created_at_epoch: Date.now(), platform_source: 'hermes', project: 'project' } as any);
      expect(imported.imported).toBe(true);
      expect(store.getUserPrompt('b', 3, b)).toBe('imported');
    } finally { store.close(); }
  });
});
