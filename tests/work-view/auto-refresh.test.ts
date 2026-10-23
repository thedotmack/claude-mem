import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { buildRefreshTask, STEP_MODELS } from '../../src/services/work-view/refresh-task.js';
import { readLedger } from '../../src/services/work-view/request-groups.mjs';

const DAY = 86400000, NOW = 100 * DAY;
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');

function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'claude', 'a', 'm1', 'repo/tree', 'Build the release cards', NOW - 3 * DAY);
  db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 1, 'Build the release cards', NOW - 3 * DAY);
  return db;
}

function saveGoals(database: Database, generatedAt: string) {
  const write = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  write.run('owner', 'owner-goals', JSON.stringify({ human_summary: 'Ship the cards.', generated_at: generatedAt }), 1);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Ship cards', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Ship cards' }), 2);
}

/** A database handle the worker may close without closing the shared fixture. */
const handle = (database: Database) => () => ({ prepare: database.prepare.bind(database), close() {} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('automatic refresh scheduler', () => {
  it('starts one run when something is due, never a second while it runs, and records the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const database = fixtureDatabase();
      let now = NOW;
      const jobs: Array<{ needs: any; reason: string }> = [];
      const finish = deferred<any>();
      const worker = new AutoRefreshWorker({ dir, openDatabase: handle(database), now: () => now, runJob: job => { jobs.push(job); return finish.promise; } });
      const first = worker.check();
      await Promise.resolve(); await Promise.resolve();
      expect(worker.status()).toMatchObject({ state: 'running', pid: process.pid, reason: 'scheduled', needs: { ungrouped: 1, goalsStale: true, needed: true } });
      // A long run is never killed or replaced: weeks of checks later it is still the one run.
      for (let check = 0; check < 5; check++) { now += 7 * DAY; expect(await worker.check()).toBe('running'); }
      expect(await worker.runNow({ reason: 'setup-scan' })).toBe('running');
      expect(jobs).toHaveLength(1);
      expect(worker.status().state).toBe('running');
      finish.resolve({ state: 'ok', agent: 'claude-code', result: 'Reviewed 1 request.', error: null });
      expect(await first).toBe('ok');
      expect(worker.status()).toMatchObject({ state: 'ok', agent: 'claude-code', result: 'Reviewed 1 request.', error: null, startedAt: new Date(NOW).toISOString(), finishedAt: new Date(now).toISOString() });
      expect(worker.revision).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('nothing due: no run, and the status says idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      let ran = false;
      const worker = new AutoRefreshWorker({ dir, openDatabase: handle(database), now: () => NOW, runJob: async () => { ran = true; return { state: 'ok', agent: null, result: null, error: null }; } });
      expect(await worker.check()).toBe('idle');
      expect(ran).toBe(false);
      expect(worker.status()).toMatchObject({ state: 'idle', needs: { needed: false } });
      // runNow runs whatever refreshNeeds says (the install funnel after its scan).
      expect(await worker.runNow({ reason: 'setup-scan' })).toBe('ok');
      expect(ran).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('no logged-in agent: waiting-for-agent, then runs on the check after one appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      let agentInstalled = false, runs = 0;
      const worker = new AutoRefreshWorker({ dir, openDatabase: handle(fixtureDatabase()), now: () => NOW, hasUsableAgent: async () => agentInstalled, runJob: async () => { runs++; return { state: 'ok', agent: 'codex', result: 'done', error: null }; } });
      expect(await worker.check()).toBe('waiting-for-agent');
      expect(worker.status()).toMatchObject({ state: 'waiting-for-agent', error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.' });
      expect(runs).toBe(0);
      agentInstalled = true;
      expect(await worker.check()).toBe('ok');
      expect(runs).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('turned off, it never checks; a run cut off by a restart is reported as failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const database = fixtureDatabase();
      let enabled = false;
      const worker = new AutoRefreshWorker({ dir, openDatabase: handle(database), now: () => NOW, enabled: () => enabled, runJob: async () => ({ state: 'failed', agent: 'gemini', result: null, error: 'gemini exited 1' }) });
      expect(await worker.check()).toBe('disabled');
      expect(worker.status()).toBeNull();
      enabled = true;
      saveGoals(database, new Date(NOW).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      writeFileSync(join(dir, 'refresh.json'), JSON.stringify({ state: 'running', pid: 2 ** 22 + 12345, startedAt: new Date(NOW - DAY).toISOString() }));
      expect(await worker.check()).toBe('idle');
      expect(worker.status()).toMatchObject({ state: 'failed', error: 'The previous refresh stopped before finishing.' });
      expect(await worker.runNow({ reason: 'manual' })).toBe('failed');
      expect(worker.status()).toMatchObject({ state: 'failed', agent: 'gemini', error: 'gemini exited 1' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('refresh task', () => {
  it('Claude Code gets only read-only tools: Read, Grep, Glob and memory search, with no Bash, Write or bypass', () => {
    const task = buildRefreshTask({ needs: { due: 2, ungrouped: 1, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: '/data', ledgerDir: '/data/work-view', pluginRoot: '/plugin', openDatabase: handle(fixtureDatabase()), now: () => NOW });
    const { claudeCode } = task;
    expect(task.cwd).toBe('/data');
    expect(claudeCode.plugins).toEqual([{ type: 'local', path: '/plugin' }]);
    expect(claudeCode.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(claudeCode.allowedTools).toContain('mcp__plugin_claude-mem_mcp-search__search');
    expect(claudeCode.allowedTools).toContain('mcp__plugin_claude-mem_mcp-search__work_state_read');
    // No raw work-state writes: they would skip the skills' validators.
    expect(claudeCode.allowedTools.filter(tool => /Bash|Write|Edit|work_state_write|save_memory|Agent|Skill/.test(tool))).toEqual([]);
    expect(JSON.stringify(task)).not.toMatch(/bypass|dangerous/i);
  });

  it('every backend (read-only): the worker groups, reviews and retells from the agent\'s JSON through the validators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-inline-'));
    try {
      const database = fixtureDatabase();
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 1, goalsStale: false, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW });
      const prompts: string[] = [];
      const models: unknown[] = [];
      let reviewAnswers = 0;
      const ask = async (prompt: string, stepModels: unknown) => {
        prompts.push(prompt);
        models.push(stepModels);
        expect(prompt).toMatch(/read-only sandbox/);
        expect(prompt).not.toContain('${CLAUDE_SKILL_DIR}');
        const file = /is in (\S+\.json)/.exec(prompt)?.[1];
        if (prompt.includes('Do only section 1')) return '```json\n{"groups": [{"title": "Release cards", "conversations": [' + JSON.stringify(key('a')) + ']}]}\n```';
        if (prompt.includes("Do only section 2")) {
          const [show] = JSON.parse(readFileSync(file!, 'utf8'));
          // The first answer forgets reviewBasis; the refusal is sent back and fixed.
          if (reviewAnswers++ === 0) return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 40, summary: 'Cards are being built.' }] });
          expect(prompt).toMatch(/refused for these groups/);
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 40, summary: 'Cards are being built.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'One request is under way.', preferences: [] });
        throw new Error(`Unexpected prompt: ${prompt.slice(-200)}`);
      };
      expect(await task.run(ask, 'codex')).toBe('1 conversations in 1 groups, 1 requests reviewed, story written.');
      const ledger = readLedger(dir);
      expect(Object.values(ledger.groups.groups).map((group: any) => group.title)).toEqual(['Release cards']);
      expect(Object.values(ledger.progress).map((review: any) => review.percent)).toEqual([40]);
      expect(ledger.story.narrative).toBe('One request is under way.');
      expect(prompts.filter(prompt => prompt.includes('section 3'))).toHaveLength(0);
      // Grouping runs on the light models; reviews and the story on the careful ones.
      expect(models).toEqual([STEP_MODELS.grouping, STEP_MODELS.review, STEP_MODELS.review, STEP_MODELS.story]);
      expect(STEP_MODELS.grouping).toEqual({ 'claude-code': { model: 'haiku' }, codex: { model: 'gpt-6-luna', reasoningEffort: 'low' }, gemini: { model: 'flash-lite' } });
      expect(STEP_MODELS.review).toEqual({ 'claude-code': { model: 'sonnet' }, codex: {}, gemini: { model: 'flash' } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('incremental owner goals', () => {
  /** A python3 stand-in: the export reports `newPrompts` prompts since the saved goals; save_goals records its goals file. */
  function fakePython(newPrompts: number, calls: Array<{ args: string[]; goals?: any }>) {
    return ((_command: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      const call: { args: string[]; goals?: any } = { args };
      calls.push(call);
      queueMicrotask(() => {
        if (args[0].endsWith('export_owner_prompts.py')) mkdirSync(args[args.indexOf('--out') + 1], { recursive: true });
        if (args[0].endsWith('export_owner_prompts.py')) child.stdout.emit('data', JSON.stringify({ owner_prompts: 40, ...(args.includes('--since') ? { new_prompts: newPrompts } : {}) }) + '\n');
        else call.goals = JSON.parse(readFileSync(args[args.indexOf('--goals') + 1], 'utf8'));
        child.emit('close', 0);
      });
      return child;
    }) as any;
  }

  it('updates the saved goals from only the prompts typed since, and keeps the saved map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-goals-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [];
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(3, calls) });
      const prompts: string[] = [];
      const ask = async (prompt: string) => {
        prompts.push(prompt);
        const previous = JSON.parse(readFileSync(/saved goals are in (\S+\.json)/.exec(prompt)![1], 'utf8'));
        expect(previous.priorities.map((item: any) => item.title)).toEqual(['Ship cards']);
        return JSON.stringify({ ...previous, priorities: [{ ...previous.priorities[0], rank: 2 }] });
      };
      expect(await task.run(ask, 'codex')).toBe('goals updated.');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('new-owner-prompts.md');
      expect(prompts[0]).toContain('3 prompts the owner typed since');
      const exportCall = calls[0].args;
      expect(exportCall.slice(exportCall.indexOf('--since'), exportCall.indexOf('--since') + 2)).toEqual(['--since', new Date(NOW - 2 * DAY).toLocaleString('sv').slice(0, 16)]);
      expect(calls[1].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 40, priorities: [{ title: 'Ship cards', rank: 2 }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with no new prompts, re-saves the saved goals without asking an agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-goals-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [];
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(0, calls) });
      expect(await task.run(async () => { throw new Error('no agent needed'); }, 'codex')).toBe('goals unchanged.');
      expect(calls[1].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), priorities: [{ title: 'Ship cards', rank: 1 }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('automatic refresh timer', () => {
  it('a check that cannot read the database is logged, not thrown, and the timer keeps going', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const logs: string[] = [];
      const worker = new AutoRefreshWorker({ dir, openDatabase: () => { throw new Error('unable to open database file'); }, runJob: async () => ({ state: 'ok', agent: null, result: null, error: null }), log: (_level, message, data) => { logs.push(`${message}: ${data?.error}`); } });
      worker.start();
      await new Promise(resolve => setImmediate(resolve));
      worker.close();
      expect(logs).toEqual(['Work view refresh check failed: unable to open database file']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
