import { afterAll, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const GENERATED = join(import.meta.dir, '.generated', `gemini-token-identity-${process.pid}`);
const AT = '2026-10-10T00:00:00.000Z';
let home: string;
let sequence = 0;

beforeEach(() => {
  home = join(GENERATED, `home-${sequence++}`);
  mkdirSync(join(home, '.gemini/tmp/example/chats'), { recursive: true });
});
afterAll(() => rmSync(GENERATED, { recursive: true, force: true }));

function chat(name: string, sessionId: string, messages: unknown[]): void {
  const header = { sessionId, kind: 'main' };
  const content = name.endsWith('.jsonl')
    ? [header, ...messages].map(record => JSON.stringify(record)).join('\n')
    : JSON.stringify({ ...header, messages });
  writeFileSync(join(home, '.gemini/tmp/example/chats', name), content);
}

function message(id: string | undefined, content: string, tokens = 100) {
  return { ...(id ? { id } : {}), type: 'gemini', timestamp: AT, content, tokens: { total: tokens } };
}

async function tokens(): Promise<number> {
  const result = await scanTokenUsage({ homeDirectory: home, sinceEpochMs: 0, agents: ['gemini-cli'] });
  return result.agents[0].tokens;
}

for (const withIds of [true, false]) {
  it(`counts a migrated Gemini response once across JSON and JSONL (${withIds ? 'native' : 'legacy'} identity)`, async () => {
    const response = message(withIds ? 'response-a' : undefined, 'original response');
    chat('session-resumed.json', 'resumed', [response]);
    chat('session-resumed.jsonl', 'resumed', [response, message(withIds ? 'response-b' : undefined, 'next response', 200)]);
    expect(await tokens()).toBe(300);
  });
}

it('preserves the global identity of a native response copied with another session header', async () => {
  const response = message('response-1', 'copied response', 100);
  chat('session-a.json', 'session-a', [response]);
  chat('session-b.json', 'session-b', [response]);
  expect(await tokens()).toBe(100);
});

it('keeps distinct native turns even when their content and timestamp match', async () => {
  chat('session-a.json', 'session-a', [message('response-1', 'same', 100), message('response-2', 'same', 200)]);
  expect(await tokens()).toBe(300);
});

it('keeps distinct legacy responses at the same timestamp', async () => {
  chat('session-a.json', 'session-a', [message(undefined, 'first', 100), message(undefined, 'second', 200)]);
  expect(await tokens()).toBe(300);
});

it('retains distinct legacy tool responses without answer text', async () => {
  chat('session-a.json', 'session-a', [
    { ...message(undefined, '', 100), toolCalls: [{ name: 'read_file', args: { path: 'a' } }] },
    { ...message(undefined, '', 200), toolCalls: [{ name: 'read_file', args: { path: 'b' } }] },
  ]);
  expect(await tokens()).toBe(300);
});

it('matches legacy migration copies even when the header has no session ID', async () => {
  const response = message(undefined, 'copied response', 100);
  chat('session-resumed.json', '', [response]);
  chat('session-resumed.jsonl', '', [response]);
  expect(await tokens()).toBe(100);
});

it('a record without a valid timestamp cannot claim a later valid response identity', async () => {
  chat('session-a.json', 'session-a', [
    { ...message('response-1', 'same'), timestamp: 'invalid' },
    message('response-1', 'same', 200),
  ]);
  expect(await tokens()).toBe(200);
});
