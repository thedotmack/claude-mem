import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';

const timestamp = '2026-11-10T10:00:00.000Z';
const prefix = 'please retain this shared specification paragraph '.repeat(6);
let home: string;
let store: SessionStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-legacy-prompts-'));
  store = new SessionStore(':memory:');
});
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }); });

function write(filename: string, messages: Array<{ text: string; sessionId?: string; uuid?: string }>) {
  const directory = join(home, '.claude', 'projects', '-example');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename + '.jsonl'), messages.map(({ text, ...identity }) => JSON.stringify({
    type: 'user', timestamp, origin: { kind: 'human' }, entrypoint: 'cli', cwd: '/example',
    ...identity, message: { role: 'user', content: text },
  })).join('\n'));
}

async function scan() {
  const scan = new SetupScan({ getStore: () => store, now: () => Date.parse('2026-11-11T00:00:00.000Z'),
    scanOptions: { homeDirectory: home, agents: ['claude-code'], resolveProject: () => 'example' } });
  scan.start();
  const state = await scan.finished();
  expect(state).toMatchObject({ phase: 'done', error: null, skippedSources: 0 });
  return state;
}

function rows() {
  return store.db.prepare(`SELECT s.content_session_id AS session, up.prompt_text AS text, up.native_prompt_id AS identity
    FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id ORDER BY up.id`).all() as Array<{ session: string; text: string; identity: string }>;
}

describe('Claude legacy prompt identity through setup import', () => {
  it('persists both long prompts that differ after the first 200 characters, once each', async () => {
    const texts = [prefix + 'then update the server.', prefix + 'then update the client.'];
    write('legacy', texts.map(text => ({ text, sessionId: 'same-session' })));
    expect((await scan()).added).toBe(2);
    expect(rows().map(row => row.text)).toEqual(texts);
    expect(new Set(rows().map(row => row.identity)).size).toBe(2);
    expect((await scan()).added).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it('keeps identical legacy prompts from different native sessions', async () => {
    write('first', [{ text: 'continue', sessionId: 'first-session' }]);
    write('second', [{ text: 'continue', sessionId: 'second-session' }]);
    expect((await scan()).added).toBe(2);
    expect(rows().map(row => row.session).sort()).toEqual(['first-session', 'second-session']);
  });

  it('uses the filename session fallback when legacy records lack a session ID', async () => {
    write('first', [{ text: 'continue' }]);
    write('second', [{ text: 'continue' }]);
    expect((await scan()).added).toBe(2);
    expect(rows().map(row => row.session).sort()).toEqual(['first', 'second']);
  });

  it('still collapses repeated copies of one legacy turn', async () => {
    const message = { text: prefix, sessionId: 'same-session' };
    write('first-copy', [message, message]);
    write('second-copy', [message]);
    expect((await scan()).added).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('keeps native UUID behavior for distinct turns and copied messages', async () => {
    const first = { text: prefix, sessionId: 'same-session', uuid: 'native-first' };
    write('first-copy', [first, { ...first, uuid: 'native-second' }]);
    write('second-copy', [first]);
    expect((await scan()).added).toBe(2);
    expect(rows().map(row => row.identity).sort()).toEqual(['transcript:native-first', 'transcript:native-second']);
  });

  it('reuses the preexisting fallback storage ID on upgrade', async () => {
    const text = 'continue the legacy task';
    const nativePromptId = createHash('sha256').update(timestamp + '\u0000' + text).digest('hex').slice(0, 32);
    store.importTranscriptUserPrompt({ platformSource: 'claude', contentSessionId: 'legacy', project: 'example',
      nativePromptId, promptText: text, createdAtEpoch: Date.parse(timestamp), hookMatchWindowMs: 1000, claimedHookRowIds: new Set() });
    write('legacy', [{ text }]);
    expect((await scan()).added).toBe(0);
    expect(rows()).toEqual([{ session: 'legacy', text, identity: 'transcript:' + nativePromptId }]);
  });
});
