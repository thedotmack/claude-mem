import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { createGeminiCliReader, readGeminiChat } from '../../../src/services/prompt-import/readers.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const AT = '2026-10-20T12:00:00.000Z';
const header = { sessionId: 'gemini-session', projectHash: 'project', kind: 'main' };
const user = (id: string, text = id) => ({ id, type: 'user', timestamp: AT, content: [{ text }] });
const assistant = (id: string, text: string, total: number) => ({ id, type: 'gemini', timestamp: AT, content: text, tokens: { total } });
let home: string;

function write(records: unknown[], extension = 'jsonl'): string {
  home ??= mkdtempSync(join(tmpdir(), 'cm-gemini-history-'));
  const path = join(home, `.gemini/tmp/project/chats/session.${extension}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, extension === 'jsonl'
    ? [header, ...records].map(record => JSON.stringify(record)).join('\n') + '\n'
    : JSON.stringify({ ...header, messages: records }));
  return path;
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined!;
});

describe('Gemini JSONL history mutations', () => {
  it('imports the rewound conversation while retaining spent usage and earlier provenance', async () => {
    const file = write([
      user('kept', 'keep the migration'),
      user('removed', 'discard the old plan'),
      assistant('removed-answer', 'Discarded assistant instructions.', 100),
      { $rewindTo: 'removed' },
      user('replacement', 'use the revised plan'),
      assistant('kept-answer', 'Current assistant instructions.', 200),
    ]);
    const scan = await scanOwnerPrompts({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'],
      excludedProjects: '', resolveProject: () => 'project' });
    expect(scan.ownerPrompts.map(prompt => prompt.text)).toEqual(['keep the migration', 'use the revised plan']);
    const reader = createGeminiCliReader();
    const stats = statSync(file);
    const authored: string[] = [];
    await reader.readAgentText({ path: file, bytes: stats.size, mtimeMs: stats.mtimeMs, holdsPrompts: true },
      (_at, text) => authored.push(text));
    expect(authored).toEqual(['Discarded assistant instructions.', 'Current assistant instructions.']);
    // Rewinding conversation history does not refund model usage.
    const usage = await scanTokenUsage({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'] });
    expect(usage.agents[0].tokens).toBe(300);
  });

  for (const rewindId of ['first', 'absent']) {
    it(`clears the active history when rewinding to ${rewindId}`, async () => {
      const file = write([user('first'), user('second'), { $rewindTo: rewindId }, user('new')]);
      expect((await readGeminiChat(file)).messages.map(message => message.id)).toEqual(['new']);
    });
  }

  it('replaces legacy full-history checkpoints instead of merging discarded messages', async () => {
    const file = write([user('old'), { $set: { messages: [user('snapshot')], summary: 'replaced' } },
      { $set: { lastUpdated: AT } }, user('appended')]);
    const result = await readGeminiChat(file);
    expect(result.messages.map(message => message.id)).toEqual(['snapshot', 'appended']);
    expect(result.header).toMatchObject({ summary: 'replaced', lastUpdated: AT });
  });

  it('honors an empty checkpoint while retaining its already-spent token usage', async () => {
    const file = write([assistant('spent', 'earlier answer', 50), { $set: { messages: [] } }]);
    expect((await readGeminiChat(file)).messages).toEqual([]);
    expect((await scanTokenUsage({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'] })).agents[0].tokens).toBe(50);
  });

  it('applies single and grouped content patches without replacing unrelated message fields', async () => {
    const answer = { ...assistant('answer', 'original answer', 100),
      toolCalls: [{ id: 'tool', name: 'read_file', args: { file_path: 'notes.md' }, result: [{ text: 'old' }] }] };
    const file = write([user('prompt', 'old request'), answer,
      { $patch: { id: 'prompt', content: [{ text: 'revised request' }] } },
      { $patch: { updates: [{ id: 'answer', content: 'revised answer' }] } }]);
    const { messages } = await readGeminiChat(file);
    expect(messages[0]).toEqual(user('prompt', 'revised request'));
    expect(messages[1]).toEqual({ ...answer, content: 'revised answer' });
    const scan = await scanOwnerPrompts({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'],
      excludedProjects: '', resolveProject: () => 'project' });
    expect(scan.ownerPrompts.map(prompt => prompt.text)).toEqual(['revised request']);
  });

  it('applies removal and ordering before a later rewind uses the active order', async () => {
    const file = write([user('prefix'), user('a'), user('remove'), user('b'), user('c'),
      { $patch: { removeIds: ['remove'], orderIds: ['c', 'a', 'b'] } },
      { $rewindTo: 'a' }]);
    expect((await readGeminiChat(file)).messages.map(message => message.id)).toEqual(['prefix', 'c']);
  });

  it('uses metadata updates when deciding whether a chat belongs to the main agent', async () => {
    write([user('child', 'delegated child request'), { $set: { kind: 'subagent' } }]);
    const scan = await scanOwnerPrompts({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'],
      excludedProjects: '', resolveProject: () => 'project' });
    expect(scan.ownerPrompts).toEqual([]);
  });

  it('keeps legacy JSON documents and ordinary same-id message updates working', async () => {
    expect((await readGeminiChat(write([user('json')], 'json'))).messages).toEqual([user('json')]);
    const file = write([user('first', 'earlier'), user('second'), user('first', 'updated')]);
    expect((await readGeminiChat(file)).messages).toEqual([user('first', 'updated'), user('second')]);
  });
});
