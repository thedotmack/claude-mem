// Funnel Phase 4: what the agent runner's extraction reads. Goals come from the prompt importer's
// owner-prompts.md (every agent, one filter); hook rows an agent wrote never become asks.
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeOwnerPromptsFile } from '../../../src/services/prompt-import/owner-prompts-file.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { buildRefreshTask } from '../../../src/services/work-view/refresh-task.js';
import { AGENT_WRITTEN_PROMPTS_FILE, readCandidates, readLedger } from '../../../src/services/work-view/request-groups.mjs';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home');
const FIXTURE_NOW = Date.parse('2026-10-10T00:00:00.000Z');
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', '..', 'plugin');
const SAVE_GOALS = join(PLUGIN_ROOT, 'skills', 'owner-goals', 'scripts', 'save_goals.py');

const agents = (...ids: Array<UsableAgent['id']>): UsableAgent[] =>
  (['claude-code', 'codex', 'gemini'] as const).map(id => ({ id, path: ids.includes(id) ? `/bin/${id}` : null, authenticated: ids.includes(id), reason: 'test' }));

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

      const goals = (quote: string) => JSON.stringify({ priorities: [{ rank: 1, title: 'Scan screen', evidence: [{ at: heading![1], quote }] }], open_asks: [] });
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

  it('writes new-owner-prompts.md with only the prompts from the `since` minute on', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'owner-prompts-file-'));
    try {
      const all = await writeOwnerPromptsFile({ folder, now: FIXTURE_NOW, scanOptions: { homeDirectory: FIXTURE_HOME } });
      expect(all.newPrompts).toBeUndefined();
      const minutes = [...readFileSync(all.path, 'utf8').matchAll(/\n## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · /g)].map(match => match[1]).sort();
      const since = minutes[minutes.length - 3];
      const written = await writeOwnerPromptsFile({ folder, since, now: FIXTURE_NOW, scanOptions: { homeDirectory: FIXTURE_HOME } });
      expect(written.newPrompts).toBe(minutes.filter(minute => minute >= since).length);
      expect(readFileSync(join(folder, 'new-owner-prompts.md'), 'utf8')).toStartWith(`# Owner prompts since ${since}\n\n${written.newPrompts} prompts, oldest first.`);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('the refresh task reads owner prompts from the prompt importer and never runs the export script', async () => {
    const database = new Database(':memory:');
    database.run('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
    const dir = mkdtempSync(join(tmpdir(), 'refresh-owner-prompts-'));
    try {
      const folders: Array<[string, string | null]> = [];
      const scripts: string[] = [];
      const task = buildRefreshTask({
        needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'setup-scan', dataDir: dir, ledgerDir: dir,
        pluginRoot: PLUGIN_ROOT, openDatabase: () => ({ prepare: database.prepare.bind(database), close() {} }), now: () => FIXTURE_NOW,
        writeOwnerPrompts: async (folder, since) => { folders.push([folder, since]); throw new Error('stop after step 1'); },
        spawnImpl: ((_command: string, args: string[]) => { scripts.push(args[0]); throw new Error('no script may run'); }) as never,
      });
      await expect(task.run(async () => '{}', 'codex')).rejects.toThrow('stop after step 1');
      expect(folders).toEqual([[join(dir, 'owner-goals', new Date(FIXTURE_NOW).toLocaleDateString('en-CA')), null]]);
      expect(scripts).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
});
