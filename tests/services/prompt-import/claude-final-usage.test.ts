import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { scanWindowStart } from '../../../src/services/prompt-import/index.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const SINCE = scanWindowStart(NOW);
const roots: string[] = [];
const iso = (at: number) => new Date(at).toISOString();

function home(): string {
  const base = join(import.meta.dir, '.generated');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'claude-final-usage-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, records: unknown[]): string {
  const path = join(root, '.claude/projects/-app', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

function assistant(id: string, at: number, output: number, finished = false, input = 10) {
  return {
    type: 'assistant', timestamp: iso(at), sessionId: 'session', requestId: `req-${id}`,
    uuid: `${id}-${at}-${output}`, message: {
      id, role: 'assistant', model: 'claude-test', stop_reason: finished ? 'end_turn' : null,
      content: [{ type: 'text', text: 'Recorded assistant response' }],
      usage: { input_tokens: input, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: output },
    },
  };
}

async function usage(root: string) {
  const result = await scanTokenUsage({ homeDirectory: root, sinceEpochMs: SINCE, agents: ['claude-code'] });
  return result.agents[0];
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('finalized Claude transcript usage', () => {
  it('uses the completed usage in setup totals and persona while importing the owner prompt once', async () => {
    const root = home();
    // Claude Code writes an assistant record for each content block; the last
    // record can contain the completed output count for the same message.id.
    const path = write(root, 'session.jsonl', [
      assistant('old', SINCE - 1, 100, true),
      { type: 'user', timestamp: iso(NOW - 1000), sessionId: 'session', uuid: 'user-1', cwd: '/app', origin: { kind: 'human' }, entrypoint: 'cli', message: { role: 'user', content: 'Keep the final usage from this response.' } },
      assistant('response', NOW - 900, 2, false, 9_999_800),
      assistant('response', NOW - 800, 2, false, 9_999_800),
      assistant('response', NOW - 700, 300, true, 9_999_800),
    ]);
    const bytes = readFileSync(path);
    const store = new SessionStore(':memory:');
    try {
      const scan = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: { homeDirectory: root, agents: ['claude-code'], resolveProject: () => 'app' } });
      scan.start();
      const state = await scan.finished();
      expect(state).toMatchObject({ phase: 'done', added: 1, usageError: null });
      expect(state.usage).toMatchObject({ totalTokens: 10_000_150, coverage: 'complete', persona: 'Medium AI User' });
      expect(store.db.query('SELECT prompt_text FROM user_prompts').all()).toEqual([{ prompt_text: 'Keep the final usage from this response.' }]);
      expect(readFileSync(path)).toEqual(bytes);
    } finally { store.close(); }
  });

  it('keeps completed subagent usage when another transcript repeats its earlier content blocks', async () => {
    const root = home();
    const initial = assistant('child-response', NOW - 200, 2);
    const complete = assistant('child-response', NOW - 100, 400, true);
    write(root, 'session/subagents/agent-a.jsonl', [initial, complete]);
    write(root, 'session/subagents/agent-b.jsonl', [initial]);
    // A message without a final count remains the observed count, not an estimate.
    write(root, 'session.jsonl', [assistant('unfinished', NOW - 50, 2), assistant('unfinished', NOW - 40, 2)]);
    expect(await usage(root)).toMatchObject({ tokens: 522, firstRecordAt: iso(NOW - 200) });
  });

  it('keeps a message in its original time window and does not merge different message ids', async () => {
    const root = home();
    write(root, 'session.jsonl', [
      assistant('before-window', SINCE - 1, 2),
      assistant('before-window', SINCE + 1, 500, true),
      assistant('in-window-a', NOW - 30, 2),
      assistant('in-window-a', NOW - 20, 100, true),
      assistant('in-window-b', NOW - 10, 100, true),
    ]);
    expect(await usage(root)).toMatchObject({ tokens: 320, firstRecordAt: iso(SINCE - 1), historyStartsBeforeWindow: true });
  });
});
