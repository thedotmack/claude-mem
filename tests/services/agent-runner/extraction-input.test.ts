// Funnel Phase 4: what the agent runner's extraction reads. Goals come from the prompt importer's
// owner-prompts.md (every agent, one filter); hook rows an agent wrote never become asks.
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgentTask, type AgentTask } from '../../../src/services/agent-runner/run.js';
import type { UsableAgent } from '../../../src/services/agent-runner/detect.js';
import { writeOwnerPromptsFile } from '../../../src/services/prompt-import/owner-prompts-file.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildRefreshTask } from '../../../src/services/work-view/refresh-task.js';
import { AGENT_WRITTEN_PROMPTS_FILE, groupingInput, readCandidates, readLedger } from '../../../src/services/work-view/request-groups.mjs';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home');
const FIXTURE_NOW = Date.parse('2026-10-10T00:00:00.000Z');
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', '..', 'plugin');
const SAVE_GOALS = join(PLUGIN_ROOT, 'skills', 'owner-goals', 'scripts', 'save_goals.py');

const agents = (...ids: Array<UsableAgent['id']>): UsableAgent[] =>
  (['claude-code', 'codex', 'gemini'] as const).map(id => ({ id, path: ids.includes(id) ? `/bin/${id}` : null, authenticated: ids.includes(id), reason: 'test' }));

function geminiTask(events: string[], prepare?: () => Promise<void>): AgentTask {
  return {
    reason: 'test', cwd: '/data', prepare,
    claudeCode: { plugins: [], tools: [], allowedTools: [] },
    run: async () => { events.push('run'); return 'done'; },
  };
}
const neverQuery = (() => { throw new Error('query must not run'); }) as never;
const env = async () => ({ PATH: '/bin' });

describe('agent runner prepare step', () => {
  it('runs once, before the first agent, and not at all without a logged-in agent', async () => {
    const events: string[] = [];
    const prepare = async () => { events.push('prepare'); };
    expect((await runAgentTask(geminiTask(events, prepare), { detect: async () => agents('codex'), query: neverQuery, buildEnv: env })).state).toBe('ok');
    expect(events).toEqual(['prepare', 'run']);
    events.length = 0;
    expect((await runAgentTask(geminiTask(events, prepare), { detect: async () => agents(), query: neverQuery, buildEnv: env })).state).toBe('waiting-for-agent');
    expect(events).toEqual([]);
  });

  it('a failed prepare is reported and no agent runs', async () => {
    const events: string[] = [];
    const result = await runAgentTask(geminiTask(events, async () => { throw new Error('transcripts unreadable'); }), { detect: async () => agents('codex'), query: neverQuery, buildEnv: env });
    expect(result).toMatchObject({ state: 'failed', agent: null, error: 'Preparing the run failed: transcripts unreadable' });
    expect(events).toEqual([]);
  });
});

describe('owner prompts from the prompt importer', () => {
  it('writes every agent\'s typed prompts in the export script\'s format, and save_goals.py verifies quotes against it', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'owner-prompts-file-'));
    try {
      const written = await writeOwnerPromptsFile({ folder, now: FIXTURE_NOW, scanOptions: { homeDirectory: FIXTURE_HOME } });
      const markdown = readFileSync(written.path, 'utf8');
      expect(markdown).toStartWith(`# Owner prompts (typed by the owner, not written by an agent), last 30 days\n\n${written.ownerPrompts} prompts, oldest first.`);
      expect(written.ownerPrompts).toBe(13);
      for (const tool of ['claude', 'codex', 'gemini', 'antigravity', 'opencode']) expect(markdown).toMatch(new RegExp(`\\n## \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · ${tool} · `));
      const heading = /## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · claude · [^\n]+\nsession `[^`]{1,8}`\n\nmake the scan screen show each agent/.exec(markdown);
      expect(heading).not.toBeNull();

      const goals = (quote: string) => JSON.stringify({ asks: [{ rank: 1, title: 'Scan screen', focus_area: null, evidence: [{ at: heading![1], quote }] }] });
      const check = (quote: string) => {
        writeFileSync(join(folder, 'owner-goals.json'), goals(quote));
        return spawnSync('python3', [SAVE_GOALS, '--goals', join(folder, 'owner-goals.json'), '--prompts', written.path, '--dry-run'], { encoding: 'utf8' });
      };
      expect(check('show each agent').status).toBe(0);
      const refused = check('words the owner never typed');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/not the owner's words/);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('the refresh task prepares owner-prompts.md for every backend and never runs the export script', async () => {
    const database = new Database(':memory:');
    database.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
    const folders: Array<[string, string | null]> = [];
    const task = buildRefreshTask({ localDeviceId: () => '',
      needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'setup-scan', dataDir: '/data', ledgerDir: '/data/work-view',
      pluginRoot: '/plugin', openDatabase: () => ({ prepare: database.prepare.bind(database), close() {} }), now: () => FIXTURE_NOW,
      writeOwnerPrompts: async (folder, sinceMinute) => { folders.push([folder, sinceMinute]); return { path: join(folder, 'owner-prompts.md'), ownerPrompts: 0, excludedAgentWritten: 0, newPrompts: 0 }; },
    });
    await task.prepare!();
    const goalsFolder = join('/data/work-view/owner-goals', new Date(FIXTURE_NOW).toLocaleDateString('en-CA'));
    // No saved goals yet: the whole window, no since minute.
    expect(folders).toEqual([[goalsFolder, null]]);
    expect(JSON.stringify(task)).not.toContain('export_owner_prompts');

    const fresh = buildRefreshTask({ localDeviceId: () => '', needs: { due: 1, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: '/data', ledgerDir: '/data/work-view', pluginRoot: '/plugin', openDatabase: () => ({ prepare: database.prepare.bind(database), close() {} }) });
    expect(fresh.prepare).toBeUndefined();
  });
});

describe('agent-written hook rows', () => {
  it('the setup scan reports hook rows the owner did not type, and grouping leaves them out', async () => {
    const store = new SessionStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'agent-written-'));
    try {
      const session = '11111111-aaaa-bbbb-cccc-000000000001';
      const sessionDbId = store.createSDKSession(session, 'alpha', 'make the scan screen show each agent', undefined, 'claude');
      store.saveUserPrompt(session, 1, 'make the scan screen show each agent', sessionDbId, undefined, undefined, Date.parse('2026-10-01T10:01:02.000Z'));
      store.saveUserPrompt(session, 2, 'Reply with ok and then build the deploy script for the agents', sessionDbId, undefined, undefined, Date.parse('2026-10-01T10:03:00.500Z'));
      const rows = store.db.prepare('SELECT id, prompt_text FROM user_prompts ORDER BY id').all() as Array<{ id: number; prompt_text: string }>;

      let saved: number[] | null = null;
      const scan = new SetupScan({
        getStore: () => store, now: () => FIXTURE_NOW,
        scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: cwd => (cwd ?? 'unknown').split('/').pop()! },
        saveAgentWrittenPromptIds: ids => { saved = ids; },
      });
      scan.start();
      await scan.finished();
      const headless = rows.find(row => row.prompt_text.startsWith('Reply with ok'))!.id;
      expect(saved).toEqual([headless]);

      writeFileSync(join(dir, AGENT_WRITTEN_PROMPTS_FILE), JSON.stringify({ promptIds: saved }));
      const excluded = readLedger(dir).agentWrittenPromptIds as Set<number>;
      const asks = (excludedPromptIds: Set<number> | null) => readCandidates(store.db, { sinceEpoch: 0, excludedPromptIds })
        .find((candidate: { conversationKey: string }) => candidate.conversationKey.includes(session))!.asks.map((ask: { text: string }) => ask.text);
      expect(asks(null).some((text: string) => text.startsWith('Reply with ok'))).toBe(true);
      expect(asks(excluded).some((text: string) => text.startsWith('Reply with ok'))).toBe(false);
      expect(asks(excluded)).toContain('make the scan screen show each agent');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('automatic grouping leaves out a conversation whose only ask is a rejected opening prompt', () => {
    const store = new SessionStore(':memory:');
    const dir = mkdtempSync(join(import.meta.dir, '..', '..', '..', '.scratch', 'agent-written-grouping-'));
    try {
      const owner = '11111111-aaaa-bbbb-cccc-000000000002';
      const agent = '11111111-aaaa-bbbb-cccc-000000000003';
      const ownerDbId = store.createSDKSession(owner, 'alpha', 'build the deploy script for the agents', undefined, 'claude');
      store.saveUserPrompt(owner, 1, 'build the deploy script for the agents', ownerDbId, undefined, undefined, Date.parse('2026-10-01T10:01:00.000Z'));
      const agentDbId = store.createSDKSession(agent, 'alpha', 'Reply with ok and then build the release notes page', undefined, 'claude');
      store.saveUserPrompt(agent, 1, 'Reply with ok and then build the release notes page', agentDbId, undefined, undefined, Date.parse('2026-10-01T10:02:00.000Z'));
      const rejected = (store.db.prepare('SELECT id FROM user_prompts WHERE session_db_id = ?').get(agentDbId) as { id: number }).id;
      writeFileSync(join(dir, AGENT_WRITTEN_PROMPTS_FILE), JSON.stringify({ promptIds: [rejected] }));
      const keys = groupingInput(readLedger(dir), store.db, { sinceEpoch: 0 }).conversations.map((conversation: { conversationKey: string }) => conversation.conversationKey);
      expect(keys.some((key: string) => key.includes(owner))).toBe(true);
      expect(keys.some((key: string) => key.includes(agent))).toBe(false);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
