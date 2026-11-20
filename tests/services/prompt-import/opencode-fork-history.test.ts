import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const SINCE = NOW - 30 * 86_400_000;

function fixture(forkColumns = true) {
  const home = mkdtempSync(join(tmpdir(), 'owned-opencode-fork-'));
  const path = join(home, '.local/share/opencode/opencode.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT
      ${forkColumns ? ', fork_session_id TEXT, time_created INTEGER' : ''});
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const session = (id: string, at: number, parent: string | null = null, fork: string | null = null) => {
    if (forkColumns) db.run('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)', [id, '/owned/fork-work', parent, fork, at]);
    else db.run('INSERT INTO session_v2 VALUES (?, ?, ?)', [id, '/owned/fork-work', parent]);
  };
  const message = (id: string, sessionId: string, type: string, data: object, at: number) => {
    const row = db.query('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM session_message WHERE session_id = ?')
      .get(sessionId) as { seq: number };
    db.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, type, row.seq, at, at, JSON.stringify({ time: { created: at, completed: at + 1 }, ...data })]);
  };
  // Mirrors v2.2.6 SessionProjector.projectFork: parent_id stays null;
  // copied messages get fresh IDs and retain timestamps, data and sequence.
  const fork = (parent: string, child: string, at: number) => {
    session(child, at, null, parent);
    db.run(`INSERT INTO session_message
      SELECT ? || '_' || seq, ?, type, seq, time_created, time_updated, data
      FROM session_message WHERE session_id = ?`, ['fork-' + child, child, parent]);
  };
  const options = {
    homeDirectory: home, agents: ['opencode' as const], sinceEpochMs: SINCE,
    excludedProjects: '', resolveProject: (cwd: string | null) => cwd ?? 'unknown',
  };
  const setup = async () => {
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
    scanner.start();
    return scanner.finished();
  };
  return { home, path, db, store, session, message, fork, options, setup,
    close() { store.close(); db.close(); rmSync(home, { recursive: true, force: true }); } };
}

it('stores new fork requests once without reimporting the copied parent history', async () => {
  const f = fixture();
  try {
    f.session('root', NOW - 20_000);
    f.message('original', 'root', 'user', { text: 'Repair the project parser.' }, NOW - 10_000);
    f.message('original-answer', 'root', 'assistant', { content: [], tokens: { input: 20, output: 5 } }, NOW - 9000);
    f.fork('root', 'branch', NOW - 6000);
    f.message('branch-request', 'branch', 'user', { text: 'Add a focused native-history regression.' }, NOW - 4000);
    f.message('branch-answer', 'branch', 'assistant', { content: [], tokens: { input: 10, output: 3 } }, NOW - 3000);
    const before = readFileSync(f.path);
    const scan = await scanOwnerPrompts(f.options);
    expect(scan.skippedSources).toEqual([]);
    expect(scan.ownerPrompts.map(p => [p.sessionId, p.nativePromptId])).toEqual([
      ['root', 'original'], ['branch', 'branch-request'],
    ]);
    expect(await f.setup()).toMatchObject({ added: 2, skippedSources: 0, usageError: null });
    expect(await f.setup()).toMatchObject({ added: 0 });
    expect(f.store.db.query(`SELECT p.prompt_text, s.content_session_id, s.platform_source
      FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY p.created_at_epoch`).all()).toEqual([
      { prompt_text: 'Repair the project parser.', content_session_id: 'root', platform_source: 'opencode' },
      { prompt_text: 'Add a focused native-history regression.', content_session_id: 'branch', platform_source: 'opencode' },
    ]);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 38, skippedSources: 0 });
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('counts actual token activity once across nested forks and the scan window', async () => {
  const f = fixture();
  try {
    f.session('root', SINCE - 10_000);
    f.message('older-usage', 'root', 'assistant', { content: [], tokens: { input: 999 } }, SINCE - 1);
    f.message('root-usage', 'root', 'assistant', { content: [],
      tokens: { input: 50, output: 20, reasoning: 10, cache: { read: 15, write: 5 } } }, SINCE + 1000);
    f.fork('root', 'branch', SINCE + 2000);
    f.message('branch-usage', 'branch', 'assistant', { content: [], tokens: { input: 30, output: 10 } }, SINCE + 3000);
    f.fork('branch', 'nested', SINCE + 4000);
    f.message('nested-usage', 'nested', 'assistant', { content: [], tokens: { input: 20, output: 3 } }, SINCE + 5000);
    const before = readFileSync(f.path);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({
      tokens: 163, skippedSources: 0, historyStartsBeforeWindow: true,
      firstRecordAt: new Date(SINCE - 1).toISOString(),
    });
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('keeps inherited assistant evidence without claiming its prompts or spend as new fork activity', async () => {
  const f = fixture();
  try {
    const authored = 'Inspect the storage migration and preserve every original native identity. Add a focused regression that verifies a repeated scan retains the same owner requests and never writes into the source database.';
    f.session('root', NOW - 20_000);
    f.message('inherited-request', 'root', 'user', { text: 'Review the old parser implementation.' }, NOW - 10_000);
    f.message('inherited-answer', 'root', 'assistant', {
      content: [{ type: 'text', text: authored }], tokens: { input: 500, output: 20 },
    }, NOW - 9000);
    f.fork('root', 'branch', NOW - 6000);
    // A retained fork can outlive its parent. Its copied assistant words are
    // still valid provenance for later input, even though no new call made them.
    f.db.run('DELETE FROM session_message WHERE session_id = ?', ['root']);
    f.db.run('DELETE FROM session_v2 WHERE id = ?', ['root']);
    f.message('copied-answer-as-input', 'branch', 'user', { text: authored }, NOW - 4000);
    f.message('new-owner-task', 'branch', 'user', { text: 'Repair the export preview.' }, NOW - 3000);
    f.message('new-spend', 'branch', 'assistant', { content: [], tokens: { input: 5 } }, NOW - 2000);
    const before = readFileSync(f.path);
    const scan = await scanOwnerPrompts(f.options);
    expect(scan.ownerPrompts.map(p => p.nativePromptId)).toEqual(['new-owner-task']);
    expect(scan.agentWritten.map(p => p.nativePromptId)).toEqual(['copied-answer-as-input']);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 5, skippedSources: 0 });
    expect(readFileSync(f.path)).toEqual(before);
  } finally { f.close(); }
});

it('keeps new activity at the fork timestamp and never deduplicates requests by text', async () => {
  const f = fixture();
  try {
    f.session('root', NOW - 20_000);
    f.message('original', 'root', 'user', { text: 'Repeat the requested check.' }, NOW - 10_000);
    f.message('original-usage', 'root', 'assistant', { content: [], tokens: { input: 10 } }, NOW - 9000);
    f.fork('root', 'branch', NOW - 5000);
    f.message('boundary-owner', 'branch', 'user', { text: 'Repeat the requested check.' }, NOW - 5000);
    f.message('boundary-usage', 'branch', 'assistant', { content: [], tokens: { input: 6 } }, NOW - 5000);
    const scan = await scanOwnerPrompts(f.options);
    expect(scan.ownerPrompts.map(p => p.nativePromptId)).toEqual(['original', 'boundary-owner']);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 16, skippedSources: 0 });
  } finally { f.close(); }
});

it('retains non-fork history and counts subagent usage without importing delegated prompts', async () => {
  const f = fixture();
  try {
    f.session('root', NOW - 2000);
    f.session('subagent', NOW - 1000, 'root');
    f.message('root-prompt', 'root', 'user', { text: 'Keep this owner request.' }, NOW - 4000);
    f.message('root-usage', 'root', 'assistant', { content: [], tokens: { input: 10 } }, NOW - 3000);
    f.message('delegated', 'subagent', 'user', { text: 'Delegated task.' }, NOW - 500);
    f.message('subagent-usage', 'subagent', 'assistant', { content: [], tokens: { input: 3 } }, NOW - 400);
    expect((await scanOwnerPrompts(f.options)).ownerPrompts.map(p => p.nativePromptId)).toEqual(['root-prompt']);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 13, skippedSources: 0 });
  } finally { f.close(); }
});

it('keeps V2 snapshots without fork columns readable', async () => {
  const f = fixture(false);
  try {
    f.session('root', NOW - 5000);
    f.message('older-layout', 'root', 'user', { text: 'Keep the established snapshot format.' }, NOW - 2000);
    f.message('older-usage', 'root', 'assistant', { content: [], tokens: { input: 8, output: 2 } }, NOW - 1000);
    expect((await scanOwnerPrompts(f.options)).ownerPrompts.map(p => p.nativePromptId)).toEqual(['older-layout']);
    expect((await scanTokenUsage(f.options)).agents[0]).toMatchObject({ tokens: 10, skippedSources: 0 });
  } finally { f.close(); }
});
