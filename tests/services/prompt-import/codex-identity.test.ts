import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { createCodexReader, type TypedPrompt } from '../../../src/services/prompt-import/readers.js';

async function read(messages: Array<{ text: string; id?: string; timestamp?: string }>, reader = createCodexReader(), sessionId: string | null = 'same-session', filename = 'rollout.jsonl'): Promise<TypedPrompt[]> {
  const folder = mkdtempSync(join(tmpdir(), 'codex-prompt-identity-'));
  try {
    const file = join(folder, filename);
    const records = [{ type: 'session_meta', payload: { ...(sessionId ? { id: sessionId } : {}), source: 'cli', cwd: '/example' } },
      ...messages.map(({ text, id, timestamp }) => ({ type: 'response_item', timestamp: timestamp ?? '2026-10-01T00:00:00.000Z',
        payload: { type: 'message', role: 'user', ...(id ? { id } : {}), content: [{ type: 'input_text', text }] } }))];
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
    const info = statSync(file);
    const result: TypedPrompt[] = [];
    await reader.readPrompts({ path: file, bytes: info.size, mtimeMs: info.mtimeMs, holdsPrompts: true },
      { prompt: prompt => result.push(prompt), session() {} }, 0);
    return result;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

describe('Codex prompt identity', () => {
  const prefix = 'a shared prompt prefix '.repeat(12);

  it('keeps distinct native messages with the same timestamp and opening', async () => {
    const result = await read([{ id: 'first', text: prefix + 'first ending' }, { id: 'second', text: prefix + 'second ending' }]);
    expect(result.map(prompt => prompt.nativePromptId)).toEqual(['first', 'second']);
  });

  it('preserves changed revisions of an existing native message', async () => {
    const result = await read([{ id: 'first', text: prefix + 'first revision' }, { id: 'first', text: prefix + 'second revision' }]);
    expect(result).toHaveLength(2);
  });

  it('preserves messages recorded at different timestamps', async () => {
    const result = await read([{ id: 'first', text: prefix }, { id: 'first', text: prefix, timestamp: '2026-10-02T00:00:00.000Z' }]);
    expect(result).toHaveLength(2);
  });

  it('persists both distinct native turns once through the transcript importer', async () => {
    const messages = [{ id: 'first', text: prefix + 'first ending' }, { id: 'second', text: prefix + 'second ending' }];
    const store = new SessionStore(':memory:');
    try {
      for (const pass of [0, 1]) {
        const reasons = [];
        for (const prompt of await read(messages)) {
          reasons.push(store.importTranscriptUserPrompt({ platformSource: 'codex', contentSessionId: prompt.sessionId,
            project: 'example', nativePromptId: prompt.nativePromptId, promptText: prompt.text,
            createdAtEpoch: prompt.at, hookMatchWindowMs: 1000, claimedHookRowIds: new Set() }).reason);
        }
        expect(reasons).toEqual(pass === 0 ? ['new', 'new'] : ['already-imported', 'already-imported']);
      }
      const rows = store.db.prepare('SELECT native_prompt_id, prompt_text FROM user_prompts ORDER BY id').all();
      expect(rows).toEqual([{ native_prompt_id: 'transcript:first', prompt_text: messages[0].text },
        { native_prompt_id: 'transcript:second', prompt_text: messages[1].text }]);
    } finally { store.close(); }
  });

  it('reuses legacy persisted IDs when a transcript has no session or message ID', async () => {
    const store = new SessionStore(':memory:');
    const original = { platformSource: 'codex', contentSessionId: 'legacy', project: 'example',
      nativePromptId: '691afea36921521f55fbf154968de0c5', promptText: 'legacy prompt',
      createdAtEpoch: Date.parse('2026-10-01T00:00:00.000Z'), hookMatchWindowMs: 1000, claimedHookRowIds: new Set<number>() };
    try {
      expect(store.importTranscriptUserPrompt(original).reason).toBe('new');
      const prompt = (await read([{ text: 'legacy prompt' }], createCodexReader(), null, 'legacy.jsonl'))[0];
      const result = store.importTranscriptUserPrompt({ ...original, nativePromptId: prompt.nativePromptId });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 1 });
      expect(result.reason).toBe('already-imported');
      expect(prompt.nativePromptId).toBe(original.nativePromptId);
    } finally { store.close(); }
  });

  it('deduplicates repeated native messages', async () => {
    expect(await read([{ id: 'first', text: prefix }, { id: 'first', text: prefix }])).toHaveLength(1);
  });

  it('uses the whole text for fallback identity when native ids are absent', async () => {
    const result = await read([{ text: prefix + 'first ending' }, { text: prefix + 'second ending' }]);
    expect(result).toHaveLength(2);
    expect(result[0].nativePromptId).not.toBe(result[1].nativePromptId);
  });

  it('keeps different fallback sessions when native session ids are absent', async () => {
    const reader = createCodexReader();
    const first = await read([{ id: 'message-1', text: prefix }], reader, null, 'first.jsonl');
    const second = await read([{ id: 'message-1', text: prefix }], reader, null, 'second.jsonl');
    expect([...first, ...second].map(prompt => prompt.sessionId)).toEqual(['first', 'second']);
  });

  it('deduplicates identical fallback messages', async () => {
    expect(await read([{ text: prefix }, { text: prefix }])).toHaveLength(1);
  });
});
