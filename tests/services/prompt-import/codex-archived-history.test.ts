import { afterEach, expect, test } from 'bun:test';
import { basename, dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createCodexReader } from '../../../src/services/prompt-import/readers.js';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const START = NOW - 30 * 86400000;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-archive-history-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const active = join(home, '.codex', 'sessions', '2026', '11', '05');
  const archive = join(home, '.codex', 'archived_sessions');
  const options = { homeDirectory: home, agents: ['codex'] as const, sinceEpochMs: START,
    excludedProjects: '', resolveProject: () => 'example' };
  return { home, active, archive, options: { ...options, agents: [...options.agents] } };
}

function rollout(folder: string, id: string, at = NOW - 1000, tokens = 25) {
  const path = join(folder, `rollout-2026-11-05T12-00-00-${id}.jsonl`);
  const timestamp = new Date(at).toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    { timestamp, type: 'session_meta', payload: { id, source: 'cli', originator: 'codex_cli_rs', cwd: '/projects/example' } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', id: `prompt-${id}`,
      content: [{ type: 'input_text', text: `Complete the ${id} task` }] } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: tokens }, last_token_usage: { total_tokens: tokens } } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  utimesSync(path, new Date(at), new Date(at));
  return path;
}

test('a native archive rename retains setup prompts without importing them twice', async () => {
  const f = fixture();
  const path = rollout(f.active, 'recent');
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  cleanup.push(() => store.close());
  const scan = new SetupScan({ getStore: () => store, now: () => NOW,
    scanOptions: f.options, detectAgents: async () => [] });
  scan.start();
  expect((await scan.finished()).added).toBe(1);
  const before = await scanOwnerPrompts(f.options);
  const modified = statSync(path).mtimeMs;
  mkdirSync(f.archive, { recursive: true });
  const moved = join(f.archive, basename(path));
  renameSync(path, moved); // Codex archives by renaming the rollout, retaining its mtime.
  expect(statSync(moved).mtimeMs).toBe(modified);
  const after = await scanOwnerPrompts(f.options);
  expect(after.ownerPrompts).toEqual(before.ownerPrompts);
  expect(after.ownerPrompts).toHaveLength(1);
  scan.start();
  const rescanned = await scan.finished();
  expect(rescanned).toMatchObject({ phase: 'done', added: 0, skippedSources: 0 });
  expect(rescanned.agents.find(agent => agent.id === 'codex')).toMatchObject({ prompts: 1, fromTranscripts: 1 });
  expect(store.db.query('SELECT COUNT(*) AS count FROM user_prompts').get()).toEqual({ count: 1 });
});

test('archiving does not change measured tokens or erase older-history coverage', async () => {
  const f = fixture();
  const path = rollout(f.active, 'recent', NOW - 1000, 123);
  const before = await scanTokenUsage(f.options);
  rollout(f.archive, 'older', START - 1000, 900);
  renameSync(path, join(f.archive, basename(path)));
  const after = await scanTokenUsage(f.options);
  expect(after.agents[0].tokens).toBe(before.agents[0].tokens);
  expect(after.agents[0]).toMatchObject({ detected: true, tokens: 123,
    historyStartsBeforeWindow: true, skippedSources: 0 });
});

test('archive-only profiles are detected while out-of-window records stay excluded', async () => {
  const f = fixture();
  rollout(f.archive, 'recent');
  const old = rollout(f.archive, 'outside', START - 1000);
  // A fresh filesystem mtime must not make an old transcript record eligible.
  utimesSync(old, new Date(NOW), new Date(NOW));
  mkdirSync(join(f.archive, 'directory.jsonl'));
  writeFileSync(join(f.archive, 'notes.txt'), 'not a rollout');
  expect(createCodexReader().locate(f.home)).toMatchObject({ detected: true });
  const prompts = await scanOwnerPrompts(f.options);
  expect(prompts.ownerPrompts.map(prompt => prompt.nativePromptId)).toEqual(['prompt-recent']);
  expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 25, historyStartsBeforeWindow: true });
});
