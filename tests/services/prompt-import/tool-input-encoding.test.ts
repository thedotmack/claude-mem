import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import type { PromptAgentId } from '../../../src/services/prompt-import/readers.js';

type Kind = 'claude-code' | 'codex-function' | 'codex-custom' | 'gemini-cli' | 'opencode';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const OLD = new Date(NOW - 10_000).toISOString(), AT = new Date(NOW).toISOString();
const PLAIN = 'Please implement the repository change with complete verification and explain the exact outcome. Capture relevant failure evidence, preserve current behavior, and record any remaining limitations for a reviewer.';
const TAB = 'Please implement the\trepository change with complete verification and explain the exact outcome and remaining limitations. '.repeat(3).trim();
const LITERAL = String.raw`Please preserve \n, \t and \" as literal characters in the implementation, then verify the exact requested outcome and remaining limitations. `.repeat(3).trim();

const WINDOWS = String.raw`Please review C:\new\tasks\review.txt and preserve the exact requested filename while verifying the outcome and recording all remaining limitations. `.repeat(3).trim();
const QUOTED = 'Please quote "verified" only after checking the exact requested outcome and explaining each remaining limitation for the reviewer. '.repeat(3).trim();

function write(home: string, path: string, records: unknown[], lines = true) {
  const target = join(home, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines ? records.map(record => JSON.stringify(record)).join('\n') + '\n' : JSON.stringify(records[0]));
}
function fixture(home: string, kind: Kind, input: unknown, text: string): PromptAgentId {
  if (kind === 'claude-code') {
    write(home, '.claude/projects/example/session.jsonl', [
      { type: 'assistant', timestamp: OLD, message: { content: [{ type: 'tool_use', id: 'tool-native', name: 'Write', input }] } },
      { type: 'user', uuid: 'user-native', sessionId: 'session', timestamp: AT, cwd: '/projects/example',
        origin: { kind: 'human' }, entrypoint: 'cli', message: { role: 'user', content: text } },
    ]);
    return 'claude-code';
  }
  if (kind === 'gemini-cli') {
    write(home, '.gemini/tmp/example/chats/session-native.json', [{ sessionId: 'session', kind: 'main', messages: [
      { id: 'agent-native', type: 'gemini', timestamp: OLD, content: '', toolCalls: [{ id: 'tool-native', name: 'write_file', args: input }] },
      { id: 'user-native', type: 'user', timestamp: AT, content: [{ text }] },
    ] }], false);
    return 'gemini-cli';
  }
  if (kind === 'opencode') {
    const folder = join(home, '.local/share/opencode');
    mkdirSync(folder, { recursive: true });
    const db = new Database(join(folder, 'opencode.db'));
    try {
      db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);`);
      db.query('INSERT INTO session VALUES(?, ?, ?)').run('session', '/projects/example', null);
      db.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('assistant', 'session', NOW - 20_000, JSON.stringify({ role: 'assistant' }));
      db.query('INSERT INTO part VALUES(?, ?, ?)').run('tool', 'assistant', JSON.stringify({ type: 'tool',
        state: { status: 'completed', input, time: { start: NOW - 10_000, end: NOW - 9000 } } }));
      db.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('user', 'session', NOW, JSON.stringify({ role: 'user' }));
      db.query('INSERT INTO part VALUES(?, ?, ?)').run('prompt', 'user', JSON.stringify({ type: 'text', text }));
    } finally { db.close(); }
    return 'opencode';
  }
  write(home, '.codex/sessions/2026/11/02/rollout.jsonl', [
    { timestamp: OLD, type: 'session_meta', payload: { id: 'session', source: 'cli', originator: 'codex_cli_rs', cwd: '/projects/example' } },
    { timestamp: OLD, type: 'response_item', payload: kind === 'codex-function'
      ? { type: 'function_call', id: 'call-native', call_id: 'call-native', name: 'write_file', arguments: typeof input === 'string' ? input : JSON.stringify(input) }
      : { type: 'custom_tool_call', id: 'call-native', call_id: 'call-native', name: 'freeform', input } },
    { timestamp: AT, type: 'response_item', payload: { type: 'message', role: 'user', id: 'user-native', content: [{ type: 'input_text', text }] } },
  ]);
  return 'codex';
}
async function check(kind: Kind, input: unknown, text: string, authored = true) {
  const home = mkdtempSync(join(tmpdir(), 'cmem-tool-encoding-'));
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const agent = fixture(home, kind, input, text);
    const options = { homeDirectory: home, agents: [agent], sinceEpochMs: NOW - 30 * 86400000,
      excludedProjects: '', resolveProject: () => 'example' };
    const result = await scanOwnerPrompts(options);
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
    scanner.start();
    const imported = await scanner.finished();
    const rows = store.db.query('SELECT prompt_text FROM user_prompts').all();
    expect({ owner: result.ownerPrompts.map(prompt => prompt.text), written: result.agentWritten.map(prompt => prompt.text),
      added: imported.added, rows }).toEqual(authored
        ? { owner: [], written: [text], added: 0, rows: [] }
        : { owner: [text], written: [], added: 1, rows: [{ prompt_text: text }] });
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
}

for (const kind of ['claude-code', 'codex-function', 'codex-custom', 'gemini-cli', 'opencode'] as Kind[]) {
  for (const [name, text] of [['tab', TAB], ['literal backslash', LITERAL], ['Windows path', WINDOWS], ['quoted text', QUOTED]]) {
    it(`${kind}: recognizes ${name} text in model tool input`, () =>
      check(kind, kind === 'codex-custom' ? text : { path: 'task.md', content: text }, text));
  }
}
for (const kind of ['claude-code', 'codex-function', 'gemini-cli', 'opencode'] as Kind[]) {
  it(`${kind}: does not invent a phrase across distinct argument fields`, () =>
    check(kind, { first: PLAIN.slice(0, PLAIN.indexOf('with')), second: PLAIN.slice(PLAIN.indexOf('with')) }, PLAIN, false));
  it(`${kind}: retains genuine serialized argument evidence`, () => {
    const input = { path: 'task.md', content: PLAIN };
    return check(kind, input, JSON.stringify(input));
  });
}
it('codex-custom: does not JSON-decode raw custom-tool text', () =>
  check('codex-custom', JSON.stringify({ content: TAB }), TAB, false));
it('codex-function: retains positive evidence from incomplete argument JSON', () => {
  const text = 'Please implement the plan.\nQuote "verified" only after checking the exact outcome and remaining limitations. '.repeat(3).trim();
  return check('codex-function', JSON.stringify({ content: text }).slice(0, -1), text);
});

it('codex-custom: does not invent newline/quote text from raw literal backslashes', () => {
  const different = LITERAL.replaceAll('\\n', '\n').replaceAll('\\"', '"');
  expect(different).not.toBe(LITERAL);
  expect(different.includes('\n')).toBe(true);
  return check('codex-custom', LITERAL, different, false);
});
it('codex-function: retains original argument JSON with escaped tabs and formatting', () => {
  const input = JSON.stringify({ content: TAB }, null, 2);
  return check('codex-function', input, input);
});
it('codex-function: recognizes Unicode escapes in argument JSON', () => {
  const text = PLAIN.replace('repository', 'répertoire');
  const input = JSON.stringify({ content: text }).replace(/[^\x00-\x7f]/g, value =>
    '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'));
  return check('codex-function', input, text);
});
for (const kind of ['claude-code', 'codex-function', 'opencode'] as Kind[]) {
  it(`${kind}: does not recursively JSON-decode string field contents`, () =>
    check(kind, { content: JSON.stringify({ sentence: TAB }) }, TAB, false));
}
