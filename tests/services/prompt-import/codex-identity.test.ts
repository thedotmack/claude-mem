import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCodexReader, type TypedPrompt } from '../../../src/services/prompt-import/readers.js';

async function read(messages: Array<{ text: string; id?: string }>, reader = createCodexReader(), sessionId: string | null = 'same-session', filename = 'rollout.jsonl'): Promise<TypedPrompt[]> {
  const folder = mkdtempSync(join(tmpdir(), 'codex-prompt-identity-'));
  try {
    const file = join(folder, filename);
    const records = [{ type: 'session_meta', payload: { ...(sessionId ? { id: sessionId } : {}), source: 'cli', cwd: '/example' } },
      ...messages.map(({ text, id }) => ({ type: 'response_item', timestamp: '2026-10-01T00:00:00.000Z',
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
