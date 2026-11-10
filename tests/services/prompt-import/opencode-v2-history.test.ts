import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { createOpenCodeReader } from '../../../src/services/prompt-import/readers.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const SINCE = NOW - 30 * 86_400_000;

function fixture(splitParts = true) {
  const home = mkdtempSync(join(tmpdir(), 'owned-opencode-v2-'));
  const path = join(home, '.local/share/opencode/opencode.db');
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  // Released OpenCode v2.2.6: core/session/sql.ts and schema/session-message.ts.
  database.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
  if (splitParts) database.exec(`CREATE TABLE session_part(message_id TEXT, session_id TEXT, ordinal INTEGER,
    type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT,
    PRIMARY KEY(message_id, ordinal));`);
  database.run('INSERT INTO session_v2 VALUES (?, ?, ?)', ['root', '/owned/current', null]);
  database.run('INSERT INTO session_v2 VALUES (?, ?, ?)', ['child', '/owned/current', 'root']);
  let seq = 0;
  const message = (id: string, type: string, data: object, at = NOW - 1000, session = 'root') => {
    database.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, session, type, seq++, at, at, JSON.stringify({ time: { created: at }, ...data })]);
  };
  const part = (messageId: string, ordinal: number, data: { type: string }, session = 'root') => {
    database.run('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [messageId, session, ordinal, data.type, null, NOW - 10_000, NOW - 5000, JSON.stringify(data)]);
  };
  const options = { homeDirectory: home, agents: ['opencode' as const], sinceEpochMs: SINCE,
    excludedProjects: '', resolveProject: (cwd: string | null) => cwd ?? 'unknown' };
  const setup = async () => {
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
    scanner.start(); return scanner.finished();
  };
  return { home, path, database, store, message, part, options, setup,
    close() { store.close(); database.close(); rmSync(home, { recursive: true, force: true }); } };
}

it('imports current V2 typed prompts and usage through SetupScan without changing native history', async () => {
  const f = fixture();
  try {
    f.message('typed', 'user', { text: 'repair the current checkout' });
    f.message('synthetic', 'synthetic', { text: 'injected continuation' });
    f.message('system', 'system', { text: 'system instructions' });
    f.message('subagent', 'user', { text: 'delegated task' }, NOW - 1000, 'child');
    f.message('old-user', 'user', { text: 'outside the scan window' }, SINCE - 1);
    f.message('answer', 'assistant', { content: [], tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 2, write: 1 } } });
    f.message('old-answer', 'assistant', { content: [], tokens: { input: 900 } }, SINCE - 1);
    const before = readFileSync(f.path);
    const result = await scanOwnerPrompts(f.options);
    expect(result.skippedSources).toEqual([]);
    expect(result.ownerPrompts.map(p => ({ text: p.text, session: p.sessionId, native: p.nativePromptId, cwd: p.cwd })))
      .toEqual([{ text: 'repair the current checkout', session: 'root', native: 'typed', cwd: '/owned/current' }]);
    const usage = (await scanTokenUsage(f.options)).agents[0];
    expect(usage).toMatchObject({ tokens: 20, skippedSources: 0, historyStartsBeforeWindow: true });
    expect(await f.setup()).toMatchObject({ added: 1, skippedSources: 0, usageError: null });
    expect(await f.setup()).toMatchObject({ added: 0 });
    expect(f.store.db.query(`SELECT p.prompt_text, s.project, s.content_session_id, s.platform_source
      FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id`).all()).toEqual([
      { prompt_text: 'repair the current checkout', project: '/owned/current', content_session_id: 'root', platform_source: 'opencode' },
    ]);
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('prefers migrated V2 identities while retaining unmigrated V1 prompts and usage', async () => {
  const f = fixture();
  try {
    f.database.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);`);
    f.database.run('INSERT INTO session VALUES (?, ?, ?)', ['root', '/owned/legacy', null]);
    const legacy = (id: string, role: string, text: string, tokens?: object) => {
      f.database.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['legacy-' + id, 'root', NOW - 1000, JSON.stringify({ role, tokens })]);
      f.database.run('INSERT INTO part VALUES (?, ?, ?)', ['part-' + id, 'legacy-' + id, JSON.stringify({ type: 'text', text })]);
    };
    legacy('typed', 'user', 'stale legacy spelling');
    legacy('unmigrated', 'user', 'keep the legacy-only task');
    legacy('synthetic', 'user', 'old synthetic representation');
    legacy('answer', 'assistant', '', { input: 999 });
    legacy('remaining-usage', 'assistant', '', { input: 11 });
    f.message('legacy-typed', 'user', { text: 'use the current spelling' });
    f.message('legacy-synthetic', 'synthetic', { text: 'injected continuation' });
    f.message('legacy-answer', 'assistant', { content: [], tokens: { input: 20, output: 3 } });
    const before = readFileSync(f.path);
    const result = await scanOwnerPrompts(f.options);
    expect(result.skippedSources).toEqual([]);
    expect(result.ownerPrompts.map(p => p.text).sort()).toEqual(['keep the legacy-only task', 'use the current spelling']);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 34, skippedSources: 0 });
    expect(await f.setup()).toMatchObject({ added: 2, skippedSources: 0 });
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM user_prompts').get()).toEqual({ count: 2 });
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

const FIRST = 'Please repair the profile reader and verify that the selected checkout retains its own attribution.';
const SECOND = 'Include a focused regression that reads the actual source data and reports the remaining limitations.';
const TEXT = `${FIRST}\n${SECOND}`;
const TOOL_TEXT = 'Review the imported prompt records and remove duplicate native identities before storing the results. Preserve the historical rows and verify that a second import does not create any additional requests.';
const OUTPUT = 'Check the instructions in this existing user document and preserve their original authorship. The content was read from disk by a tool, so it must remain eligible as an owner request rather than become model-authored evidence.';
const FUTURE = 'Inspect the lifecycle of this tool invocation and report when its arguments were actually produced. An assistant message started earlier does not make a later tool invocation evidence for a preceding user request.';

for (const layout of ['inline', 'split', 'mixed'] as const) {
  it(`retains ordered ${layout} V2 assistant text and tool-input provenance during setup`, async () => {
    const f = fixture(layout !== 'inline');
    try {
      const textParts = [{ type: 'text', text: FIRST }, { type: 'text', text: SECOND }];
      const tool = (id: string, input: object | string, ran: number, status = 'completed', content = 'stored') => ({
        type: 'tool', id, name: 'write', state: { status, input, content: [{ type: 'text', text: content }] },
        time: { created: NOW - 15_000, ran, completed: ran + 100 },
      });
      const tools = [
        tool('authored', { path: '/owned/plan.md', content: TOOL_TEXT }, NOW - 5000, layout === 'split' ? 'running' : layout === 'mixed' ? 'error' : 'completed'),
        tool('read', { path: '/owned/user.md' }, NOW - 5000, 'completed', OUTPUT),
        tool('future', { content: FUTURE }, NOW + 1000),
        tool('streaming', JSON.stringify({ content: OUTPUT }), NOW - 5000, 'streaming'),
        { type: 'reasoning', text: OUTPUT },
      ];
      const inline = layout === 'inline' ? [...textParts, ...tools] : layout === 'mixed' ? [textParts[1], ...tools] : [];
      f.message('assistant', 'assistant', { content: inline }, NOW - 20_000, 'child');
      if (layout === 'split') {
        // Deliberately insert backwards; the native history order is ordinal.
        [...textParts, ...tools].map((part, ordinal) => ({ part, ordinal })).reverse()
          .forEach(({ part, ordinal }) => f.part('assistant', ordinal, part, 'child'));
      } else if (layout === 'mixed') f.part('assistant', 0, textParts[0], 'child');
      for (const [id, text] of [['copied-text', TEXT], ['copied-tool', TOOL_TEXT], ['owner-output', OUTPUT], ['owner-future', FUTURE]]) {
        f.message(id, 'user', { text }, NOW);
      }
      const before = readFileSync(f.path);
      const result = await scanOwnerPrompts(f.options);
      expect(result.skippedSources).toEqual([]);
      expect(result.agentWritten.map(p => p.text).sort()).toEqual([TEXT, TOOL_TEXT].sort());
      expect(result.ownerPrompts.map(p => p.text).sort()).toEqual([OUTPUT, FUTURE].sort());
      const evidence: Array<{ at: number; text: string }> = [];
      const reader = createOpenCodeReader();
      await reader.readAgentText(reader.locate(f.home).sources[0], (at, text) => evidence.push({ at, text }));
      expect(evidence).toContainEqual({ at: Math.floor((NOW - 20_000) / 1000), text: TEXT });
      expect(evidence).toContainEqual({ at: Math.floor((NOW - 5000) / 1000), text: TOOL_TEXT });
      expect(evidence.some(item => item.text.includes(OUTPUT))).toBe(false);
      expect(await f.setup()).toMatchObject({ added: 2, skippedSources: 0 });
      expect(f.store.db.query('SELECT prompt_text FROM user_prompts ORDER BY prompt_text').all())
        .toEqual([OUTPUT, FUTURE].sort().map(prompt_text => ({ prompt_text })));
      expect(readFileSync(f.path)).toEqual(before);
    } finally { f.close(); }
  });
}
