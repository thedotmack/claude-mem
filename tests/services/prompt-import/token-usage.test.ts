import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { observationTokenEconomics, personaFor, scanTokenUsage, summarizeTokenUsage } from '../../../src/services/prompt-import/token-usage.js';
import { scanWindowStart } from '../../../src/services/prompt-import/index.js';

// Fixture homes are written per test under this test folder (never the system temp folder) and removed afterwards.
const GENERATED = join(import.meta.dir, '.generated', `token-usage-${process.pid}`);
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
const SINCE = scanWindowStart(NOW);
const OBSERVER_CWD = '/home/test/.claude-mem/observer-sessions';
const iso = (epochMs: number) => new Date(epochMs).toISOString();
const DAY = 86_400_000;

let home: string;
let homeCount = 0;

function write(relativePath: string, content: string, mtimeMs?: number): void {
  const path = join(home, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

const lines = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

function claudeAssistant(id: string, at: number, usage: Record<string, number>) {
  return { type: 'assistant', timestamp: iso(at), sessionId: 's1', requestId: `req-${id}`, uuid: `u-${id}-${Math.random()}`, message: { id, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage } };
}

function codexTokenCount(at: number, total: number, last: number) {
  return { timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total }, last_token_usage: { total_tokens: last } } } };
}

/** Claude Code, Codex, Gemini CLI, OpenCode and Antigravity CLI files, as their agents write them. */
function writeAgentFiles(firstUseAt: number): void {
  // Claude Code: one message written once per content block (same id, counts once); one before the window.
  write('.claude/projects/-home-test-app/s1.jsonl', lines([
    { type: 'user', timestamp: iso(firstUseAt), message: { role: 'user', content: 'hi' } },
    claudeAssistant('m-old', firstUseAt, { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }),
    claudeAssistant('m1', NOW - 2 * DAY, { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 300 }),
    claudeAssistant('m1', NOW - 2 * DAY + 500, { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 300 }),
    claudeAssistant('m2', NOW - DAY, { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000, output_tokens: 90 }),
  ]));
  // A subagent of that session.
  write('.claude/projects/-home-test-app/s1/subagents/agent-a.jsonl', lines([
    claudeAssistant('m3', NOW - DAY, { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }),
  ]));
  // claude-mem's own observer: not the person's usage.
  write('.claude/projects/-home-test--claude-mem-observer-sessions/obs.jsonl', lines([
    claudeAssistant('m-observer', NOW - DAY, { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
  ]));
  // Codex: a running total, often repeated; only increases count.
  write('.codex/sessions/2026/10/08/rollout-a.jsonl', lines([
    { timestamp: iso(NOW - 2 * DAY), type: 'session_meta', payload: { id: 'c1', source: 'cli', cwd: '/home/test/app' } },
    { timestamp: iso(NOW - 2 * DAY), type: 'event_msg', payload: { type: 'token_count', info: null } },
    codexTokenCount(NOW - 2 * DAY, 4000, 4000),
    codexTokenCount(NOW - 2 * DAY + 1, 4000, 4000),
    codexTokenCount(NOW - 2 * DAY + 2, 10_000, 6000),
  ]));
  // Gemini CLI: `$set` lines repeat messages; each id counts once.
  const geminiMessage = { id: 'g1', type: 'gemini', timestamp: iso(NOW - DAY), content: 'done', tokens: { input: 700, output: 20, cached: 300, thoughts: 30, tool: 0, total: 750 } };
  write('.gemini/tmp/app/chats/session-1.jsonl', lines([
    { sessionId: 'gs1', kind: 'main' },
    { id: 'gu1', type: 'user', timestamp: iso(NOW - DAY), content: [{ text: 'go' }] },
    geminiMessage,
    { $set: { messages: [geminiMessage] } },
  ]));
  // OpenCode: tokens on assistant messages.
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  const database = new Database(join(home, '.local/share/opencode/opencode.db'));
  database.run('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  database.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['o1', 'os1', NOW - DAY, JSON.stringify({ role: 'assistant', tokens: { input: 50, output: 5, reasoning: 5, cache: { read: 40, write: 0 } } })]);
  database.run('INSERT INTO message VALUES (?, ?, ?, ?)', ['o0', 'os1', NOW - DAY, JSON.stringify({ role: 'user' })]);
  database.close();
  // Antigravity CLI: typed history only, no token counts.
  write('.gemini/antigravity-cli/history.jsonl', lines([{ display: 'hello', timestamp: NOW - DAY, workspace: '/home/test/app' }]));
}

const CLAUDE_IN_WINDOW = (2 + 1000 + 5000 + 300) + (10 + 6000 + 90) + (100 + 100);
const CODEX_IN_WINDOW = 10_000;
const GEMINI_IN_WINDOW = 750;
const OPENCODE_IN_WINDOW = 100;
const TOTAL_IN_WINDOW = CLAUDE_IN_WINDOW + CODEX_IN_WINDOW + GEMINI_IN_WINDOW + OPENCODE_IN_WINDOW;

const scan = () => scanTokenUsage({ sinceEpochMs: SINCE, homeDirectory: home, excludedClaudeCwds: [OBSERVER_CWD] });
const tokensByAgent = (agents: Array<{ id: string; tokens: number }>) => Object.fromEntries(agents.map(agent => [agent.id, agent.tokens]));
const observation = (text: string, discoveryTokens: number | null) => ({ title: text, subtitle: null, narrative: text, facts: null, discovery_tokens: discoveryTokens });

beforeEach(() => { home = join(GENERATED, `home-${homeCount++}`); mkdirSync(home, { recursive: true }); });
afterAll(() => { rmSync(GENERATED, { recursive: true, force: true }); });

describe('token usage reader', () => {
  it('complete history: sums each agent once per message, leaves out claude-mem, and names a persona', async () => {
    writeAgentFiles(SINCE - 5 * DAY);
    const usage = await scan();
    expect(tokensByAgent(usage.agents)).toEqual({
      'claude-code': CLAUDE_IN_WINDOW, codex: CODEX_IN_WINDOW, 'gemini-cli': GEMINI_IN_WINDOW, 'antigravity-cli': 0, opencode: OPENCODE_IN_WINDOW,
    });
    expect(usage.agents.find(agent => agent.id === 'antigravity-cli')).toMatchObject({ detected: true, recordsTokens: false });
    expect(usage.agents.find(agent => agent.id === 'claude-code')).toMatchObject({ historyStartsBeforeWindow: true, firstRecordAt: iso(SINCE - 5 * DAY) });

    const summary = summarizeTokenUsage(usage, null);
    expect(summary).toMatchObject({ totalTokens: TOTAL_IN_WINDOW, coverage: 'complete', persona: 'Light AI User', efficiencyPercent: null, observations: 0 });
  });

  it('older transcripts on disk also make the window complete, without reading them', async () => {
    writeAgentFiles(NOW - 3 * DAY);
    write('.codex/sessions/2026/08/01/rollout-old.jsonl', lines([codexTokenCount(SINCE - 40 * DAY, 9_999_999, 9_999_999)]), SINCE - 40 * DAY);
    const usage = await scan();
    expect(usage.agents.find(agent => agent.id === 'codex')).toMatchObject({ tokens: CODEX_IN_WINDOW, historyStartsBeforeWindow: true });
    expect(summarizeTokenUsage(usage, null).coverage).toBe('complete');
  });

  it('partial history: records begin inside the window, so the persona is omitted', async () => {
    writeAgentFiles(NOW - 3 * DAY);
    const summary = summarizeTokenUsage(await scan(), null);
    // The first Claude Code message (1,000 tokens) now falls inside the window too.
    expect(summary).toMatchObject({ totalTokens: TOTAL_IN_WINDOW + 1000, coverage: 'partial', persona: null, efficiencyPercent: null });
  });

  it('partial history: Claude Code deletes transcripts sooner than the window', async () => {
    writeAgentFiles(SINCE - 5 * DAY);
    write('.claude/settings.json', JSON.stringify({ cleanupPeriodDays: 7 }));
    const usage = await scan();
    expect(usage.agents.find(agent => agent.id === 'claude-code')).toMatchObject({ retentionShorterThanWindow: true });
    expect(summarizeTokenUsage(usage, null)).toMatchObject({ coverage: 'partial', persona: null });
  });

  it('no history: no tokens, no persona, no percent', async () => {
    const summary = summarizeTokenUsage(await scan(), observationTokenEconomics([]));
    expect(summary).toMatchObject({ totalTokens: 0, coverage: 'none', persona: null, efficiencyPercent: null, observations: 0 });
    expect(summary.agents.every(agent => !agent.detected)).toBe(true);
  });

  it('persona thresholds follow DATA-CONTRACT.md', () => {
    expect([0, 9_999_999, 10_000_000, 49_999_999, 50_000_000, 149_999_999, 150_000_000].map(personaFor)).toEqual([
      'Light AI User', 'Light AI User', 'Medium AI User', 'Medium AI User', 'Heavy AI User', 'Heavy AI User', 'Cracked Dev',
    ]);
  });
});

describe('efficiency percent from claude-mem observations', () => {
  const completeUsage = { windowStart: iso(SINCE), windowDays: 30, agents: [{ id: 'claude-code' as const, label: 'Claude Code', detected: true, recordsTokens: true, tokens: 60_000_000, historyStartsBeforeWindow: true, firstRecordAt: iso(SINCE - DAY), retentionShorterThanWindow: false, skippedSources: 0 }] };

  it('is calculateTokenEconomics().savingsPercent, the same in batches as all at once', () => {
    const rows = Array.from({ length: 2500 }, (_, index) => observation('x'.repeat(40 + (index % 7)), 100 + (index % 13)));
    const batched = observationTokenEconomics(rows, 1000);
    expect(batched).toEqual(observationTokenEconomics(rows, rows.length));
    const summary = summarizeTokenUsage(completeUsage, batched);
    expect(summary).toMatchObject({ persona: 'Heavy AI User', efficiencyPercent: batched.savingsPercent, observations: 2500 });
    expect(batched.savingsPercent).toBeGreaterThan(0);
  });

  it('is omitted when observations carry no discovery tokens, or reading them saves nothing', () => {
    expect(summarizeTokenUsage(completeUsage, observationTokenEconomics([observation('a note', null)])).efficiencyPercent).toBeNull();
    expect(summarizeTokenUsage(completeUsage, observationTokenEconomics([observation('x'.repeat(400), 1)])).efficiencyPercent).toBeNull();
  });
});

describe('setup scan carries the token usage', () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => { store.close(); });

  it('reports usage in the same pass; a new install has no percent', async () => {
    writeAgentFiles(SINCE - 5 * DAY);
    const setupScan = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: { homeDirectory: home, resolveProject: () => 'app' } });
    expect(setupScan.state()).toMatchObject({ usage: null, usageError: null });
    setupScan.start();
    const state = await setupScan.finished();
    expect(state).toMatchObject({ phase: 'done', usageError: null });
    expect(state.usage).toMatchObject({ coverage: 'complete', persona: 'Light AI User', efficiencyPercent: null, observations: 0 });
    // The default exclusion is claude-mem's real observer folder, so the fixture observer counts here.
    expect(state.usage!.totalTokens).toBe(TOTAL_IN_WINDOW + 1_000_000);
  });

  it('an unreadable usage scan is reported, and the prompt scan still finishes', async () => {
    const setupScan = new SetupScan({
      getStore: () => store, now: () => NOW, scanOptions: { homeDirectory: home },
      readTokenUsage: async () => { throw new Error('usage exploded'); },
    });
    setupScan.start();
    expect(await setupScan.finished()).toMatchObject({ phase: 'done', usage: null, usageError: 'usage exploded' });
  });
});
