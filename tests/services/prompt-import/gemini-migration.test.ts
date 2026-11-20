import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';

for (const withIds of [true, false]) {
  it(`imports each Gemini prompt once when a resumed JSON session also has a JSONL copy (${withIds ? 'native ids' : 'legacy ids'})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gemini-migration-'));
    try {
      const chats = join(home, '.gemini', 'tmp', 'example', 'chats');
      mkdirSync(chats, { recursive: true });
      const header = { sessionId: 'resumed-session', kind: 'main' };
      const first = { ...(withIds ? { id: 'first' } : {}), type: 'user', timestamp: '2026-09-16T00:00:00Z', content: [{ text: 'explain the original behavior' }] };
      const next = { ...(withIds ? { id: 'next' } : {}), type: 'user', timestamp: '2026-09-16T00:01:00Z', content: [{ text: 'continue in the resumed session' }] };
      writeFileSync(join(chats, 'session-resumed.json'), JSON.stringify({ ...header, messages: [first] }));
      writeFileSync(join(chats, 'session-resumed.jsonl'), [header, first, next].map(record => JSON.stringify(record)).join('\n'));
      const result = await scanOwnerPrompts({ sinceEpochMs: 0, homeDirectory: home, resolveProject: () => 'example' });
      expect(result.ownerPrompts.map(prompt => prompt.text)).toEqual(['explain the original behavior', 'continue in the resumed session']);
      expect(result.agents.find(agent => agent.id === 'gemini-cli')!.typed).toBe(2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

it('keeps distinct Gemini turns and a changed revision rather than deduplicating only by text or id', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gemini-distinct-turns-'));
  try {
    const chats = join(home, '.gemini', 'tmp', 'example', 'chats');
    mkdirSync(chats, { recursive: true });
    const header = { sessionId: 'distinct-session', kind: 'main' };
    const original = { id: 'first', type: 'user', timestamp: '2026-09-16T00:00:00Z', content: [{ text: 'continue' }] };
    const revision = { ...original, content: [{ text: 'continue with the corrected instructions' }] };
    const repeated = { ...original, id: 'second', timestamp: '2026-09-16T00:02:00Z' };
    writeFileSync(join(chats, 'session-distinct.json'), JSON.stringify({ ...header, messages: [original] }));
    writeFileSync(join(chats, 'session-distinct.jsonl'), [header, revision, repeated].map(record => JSON.stringify(record)).join('\n'));
    const result = await scanOwnerPrompts({ sinceEpochMs: 0, homeDirectory: home, resolveProject: () => 'example' });
    expect(result.ownerPrompts.map(prompt => prompt.text).sort()).toEqual(['continue', 'continue', 'continue with the corrected instructions']);
    expect(result.agents.find(agent => agent.id === 'gemini-cli')!.typed).toBe(3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
