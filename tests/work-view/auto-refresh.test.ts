import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setFakeSpawn } from '../helpers/fake-spawn.js';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { buildRefreshTask, GROUPING_ANSWER_SCHEMA, STEP_MODELS } from '../../src/services/work-view/refresh-task.js';
import { readLedger, runCli } from '../../src/services/work-view/request-groups.mjs';

const DAY = 86400000, NOW = 100 * DAY;
afterEach(() => setFakeSpawn(null));
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');

function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
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
      const steps = [{ step: 'review', agent: 'claude-code', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(now).toISOString(), groups: 1 }];
      finish.resolve({ state: 'ok', agent: 'claude-code', result: 'Reviewed 1 request.', error: null, steps });
      expect(await first).toBe('ok');
      expect(worker.status()).toMatchObject({ state: 'ok', agent: 'claude-code', result: 'Reviewed 1 request.', error: null, startedAt: new Date(NOW).toISOString(), finishedAt: new Date(now).toISOString(), steps });
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
      // The install funnel's runNow after a re-scan that found nothing new starts no agent either.
      expect(await worker.runNow({ reason: 'setup-scan' })).toBe('idle');
      expect(ran).toBe(false);
      // Once something is due (a new conversation), runNow runs right away instead of at the next check.
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: {} }));
      expect(await worker.runNow({ reason: 'setup-scan' })).toBe('ok');
      expect(ran).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('no logged-in agent: waiting-for-agent, then runs on the check after one appears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      // runAgentTask detects agents once per run and answers waiting-for-agent without running anything.
      let agentInstalled = false;
      const worker = new AutoRefreshWorker({ dir, openDatabase: handle(fixtureDatabase()), now: () => NOW, runJob: async () => agentInstalled
        ? { state: 'ok', agent: 'codex', result: 'done', error: null }
        : { state: 'waiting-for-agent', agent: null, result: null, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.' } });
      expect(await worker.check()).toBe('waiting-for-agent');
      expect(worker.status()).toMatchObject({ state: 'waiting-for-agent', error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.', nextAt: new Date(NOW + 10 * 60000).toISOString() });
      agentInstalled = true;
      expect(await worker.check()).toBe('ok');
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
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: {} }));
      expect(await worker.runNow({ reason: 'manual' })).toBe('failed');
      expect(worker.status()).toMatchObject({ state: 'failed', agent: 'gemini', error: 'gemini exited 1' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('refresh task', () => {
  it('Claude Code gets only read-only tools: Read, Grep, Glob and memory search, with no Bash, Write or bypass', () => {
    const task = buildRefreshTask({ needs: { due: 2, ungrouped: 1, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: '/data', ledgerDir: '/data/work-view', pluginRoot: '/plugin', openDatabase: handle(fixtureDatabase()), now: () => NOW });
    const { claudeCode } = task;
    // The work-view folder, not the data dir that holds .env and settings.json.
    expect(task.cwd).toBe('/data/work-view');
    expect(claudeCode.plugins).toEqual([{ type: 'local', path: '/plugin' }]);
    expect(claudeCode.tools).toEqual(['Read', 'Grep', 'Glob']);
    // File tools are approved per call, only inside the work-view folder.
    expect(claudeCode.readableFolders).toEqual(['/data/work-view']);
    expect(claudeCode.allowedTools.filter(tool => ['Read', 'Grep', 'Glob'].includes(tool))).toEqual([]);
    expect(claudeCode.allowedTools).toContain('mcp__plugin_claude-mem_mcp-search__search');
    expect(claudeCode.allowedTools).toContain('mcp__plugin_claude-mem_mcp-search__work_state_read');
    // No raw work-state writes: they would skip the skills' validators.
    expect(claudeCode.allowedTools.filter(tool => /Bash|Write|Edit|work_state_write|save_memory|smart_search|smart_outline|smart_unfold|Agent|Skill/.test(tool))).toEqual([]);
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
        // Codex and Gemini run without MCP servers: no instruction to search memory, the evidence is inline.
        expect(prompt).toMatch(/You have no memory tools/);
        expect(prompt).not.toMatch(/with its MCP tools/);
        expect(prompt).not.toContain('${CLAUDE_SKILL_DIR}');
        const file = /is in (\S+\.json)/.exec(prompt)?.[1];
        if (prompt.includes('Do only section 1')) return '```json\n{"groups": [{"title": "Release cards", "conversations": [' + JSON.stringify(key('a')) + ']}]}\n```';
        if (prompt.includes("Do only section 2")) {
          const supplied = prompt.split(`--- ${file} ---\n`)[1];
          expect(supplied).toBeDefined();
          const [show] = JSON.parse(supplied);
          // The first answer forgets reviewBasis; the refusal is sent back and fixed.
          if (reviewAnswers++ === 0) return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 40, summary: 'Cards are being built.' }] });
          expect(prompt).toMatch(/refused for these groups/);
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 40, summary: 'Cards are being built.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'One request is under way.', preferences: [] });
        throw new Error(`Unexpected prompt: ${prompt.slice(-200)}`);
      };
      expect(await task.run(ask, 'gemini')).toBe('1 new conversations grouped, 1 requests reviewed, story written.');
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

describe('Codex grouping answers', () => {
  const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'codex');
  const groupingTask = (dir: string, database: Database) => buildRefreshTask({ needs: { due: 0, ungrouped: 1, goalsStale: false, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW });

  it('grouping asks for the apply schema, and a schema-shaped Codex answer is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-codex-schema-'));
    try {
      const database = fixtureDatabase();
      const schemas: unknown[] = [];
      const ask = async (prompt: string, _models: unknown, schema?: unknown) => {
        schemas.push(schema);
        if (prompt.includes('Do only section 1')) return readFileSync(join(FIXTURES, 'grouping-answer-schema.txt'), 'utf8');
        if (prompt.includes('Do only section 2')) {
          const [show] = JSON.parse(readFileSync(/is in (\S+\.json)/.exec(prompt)![1], 'utf8'));
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis }] });
        }
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await groupingTask(dir, database).run(ask, 'codex')).toBe('1 new conversations grouped, 1 requests reviewed, story written.');
      expect(schemas[0]).toBe(GROUPING_ANSWER_SCHEMA);
      expect(Object.values(readLedger(dir).groups.groups).map((group: any) => group.title)).toEqual(['Release cards for My Work']);
      // Strict structured output: every object lists all its properties as required and allows no others.
      const objects: any[] = [];
      const walk = (node: any) => { if (node?.type === 'object') objects.push(node); for (const value of Object.values(node ?? {})) if (value && typeof value === 'object') walk(value); };
      walk(GROUPING_ANSWER_SCHEMA);
      expect(objects.length).toBe(4);
      for (const object of objects) { expect(object.additionalProperties).toBe(false); expect(object.required).toEqual(Object.keys(object.properties)); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a malformed answer (recorded Oct 23 Codex output: arrays closed twice) fails loudly with the raw answer kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-codex-malformed-'));
    try {
      const malformed = readFileSync(join(FIXTURES, 'grouping-answer-malformed.txt'), 'utf8');
      const prompts: string[] = [];
      const ask = async (prompt: string) => { prompts.push(prompt); return malformed; };
      const error = await groupingTask(dir, fixtureDatabase()).run(ask, 'codex').then(() => null, failure => failure as Error);
      expect(error?.message).toMatch(/^grouping \(raw answer: .+failed-answers.+-grouping-codex\.txt\): JSON Parse error/);
      expect(readFileSync(/\(raw answer: (.+?\.txt)\)/.exec(error!.message)![1], 'utf8')).toBe(malformed);
      // Asked once more with the reason before failing; nothing was grouped.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatch(/Your previous answer was refused: JSON Parse error/);
      expect(Object.keys(readLedger(dir).groups.groups)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('alignment prompt', () => {
  it('carries the align-input inline and names every group to decide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-align-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW).toISOString());
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }] }));
      runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
      const task = buildRefreshTask({ needs: { due: 1, ungrouped: 0, goalsStale: false, unaligned: 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW });
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 2')) {
          const [show] = JSON.parse(readFileSync(/is in (\S+\.json)/.exec(prompt)![1], 'utf8'));
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 3')) {
          const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt.slice(prompt.indexOf('Do only section 3')))![1]);
          expect(JSON.parse(readFileSync(/also saved in (\S+\.json)/.exec(prompt)![1], 'utf8'))).toEqual(input);
          expect(prompt).toContain(`Decide each of these 1 groups, in "links" or "unaligned": ${input.groups[0].groupId}.`);
          return JSON.stringify({ links: [], unaligned: [input.groups[0].groupId] });
        }
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await task.run(ask, 'codex')).toBe('1 requests reviewed, 0 linked to goals, story written.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('parallel reviews', () => {
  it('review batches run at the same time, and every batch is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-parallel-'));
    try {
      const database = fixtureDatabase();
      const sessions = 'bcdefghij'.split('');
      sessions.forEach((session, index) => {
        database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(index + 2, 'claude', session, `m${index + 2}`, 'repo/tree', `Build feature ${session}`, NOW - 2 * DAY);
        database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(index + 2, 1, `Build feature ${session}`, NOW - 2 * DAY);
      });
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: ['a', ...sessions].map(session => ({ title: `Feature ${session}`, conversations: [key(session)] })) }));
      runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
      const task = buildRefreshTask({ needs: { due: 10, ungrouped: 0, goalsStale: false, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW });
      let inFlight = 0, most = 0;
      const bothAsked = deferred<void>();
      let lastPrompt = '';
      const ask = async (prompt: string) => {
        lastPrompt = prompt;
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'Ten features under way.' });
        const shows = JSON.parse(readFileSync(/is in (\S+\.json)/.exec(prompt)![1], 'utf8'));
        most = Math.max(most, ++inFlight);
        if (most === 2) bothAsked.resolve();
        await bothAsked.promise;
        inFlight--;
        return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 30, summary: 'Under way.', reviewBasis: show.reviewBasis })) });
      };
      expect(await task.run(ask, 'claude-code')).toBe('10 requests reviewed, story written.');
      expect(lastPrompt).toMatch(/Search claude-mem memory with its MCP tools/);
      expect(most).toBe(2);
      // refresh.json's run record gets one timing per step and review batch.
      expect(task.steps.map(timing => [timing.step, timing.agent, timing.groups])).toEqual([['review', 'claude-code', 8], ['review', 'claude-code', 2], ['story', 'claude-code', undefined]]);
      expect(task.steps.every(timing => timing.startedAt === new Date(NOW).toISOString() && timing.finishedAt === timing.startedAt)).toBe(true);
      expect(Object.keys(readLedger(dir).progress)).toHaveLength(10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('incremental owner goals', () => {
  /** The prompt importer stand-in: 40 owner prompts, `newPrompts` of them since the saved goals; records each since minute. */
  function fakeOwnerPrompts(newPrompts: number, sinceMinutes: Array<string | null>) {
    return async (folder: string, sinceMinute: string | null) => {
      sinceMinutes.push(sinceMinute);
      mkdirSync(folder, { recursive: true });
      return { path: join(folder, 'owner-prompts.md'), ownerPrompts: 40, excludedAgentWritten: 0, newPrompts: sinceMinute ? newPrompts : 0 };
    };
  }
  /** A python3 stand-in: save_goals records its goals file. */
  function fakePython(calls: Array<{ args: string[]; goals?: any }>) {
    return ((_command: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      const call: { args: string[]; goals?: any } = { args };
      calls.push(call);
      queueMicrotask(() => {
        call.goals = JSON.parse(readFileSync(args[args.indexOf('--goals') + 1], 'utf8'));
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
      let clock = NOW;
      const calls: Array<{ args: string[]; goals?: any }> = [], sinceMinutes: Array<string | null> = [];
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => clock, spawnImpl: fakePython(calls), writeOwnerPrompts: fakeOwnerPrompts(3, sinceMinutes) });
      await task.prepare!();
      const prompts: string[] = [];
      const ask = async (prompt: string) => {
        prompts.push(prompt);
        // The agent takes five minutes; a prompt typed meanwhile is not in this export.
        clock += 5 * 60000;
        const previous = JSON.parse(readFileSync(/saved goals are in (\S+\.json)/.exec(prompt)![1], 'utf8'));
        expect(previous.priorities.map((item: any) => item.title)).toEqual(['Ship cards']);
        return JSON.stringify({ ...previous, priorities: [{ ...previous.priorities[0], rank: 2 }] });
      };
      expect(await task.run(ask, 'codex')).toBe('goals updated.');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('new-owner-prompts.md');
      expect(prompts[0]).toContain('3 prompts the owner typed since');
      expect(sinceMinutes).toEqual([new Date(NOW - 2 * DAY).toLocaleString('sv').slice(0, 16)]);
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 40, priorities: [{ title: 'Ship cards', rank: 2 }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an empty history saves an empty snapshot without any model call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-empty-goals-'));
    try {
      const database = fixtureDatabase();
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [];
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(calls), writeOwnerPrompts: async (folder, sinceMinute) => ({ ...await fakeOwnerPrompts(0, [])(folder, sinceMinute), ownerPrompts: 0 }) });
      await task.prepare!();
      expect(await task.run(async () => { throw new Error('empty input must not call a model'); }, 'codex')).toBe('goals empty.');
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 0, priorities: [], open_asks: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with no new prompts, re-saves the saved goals without asking an agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-goals-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [], sinceMinutes: Array<string | null> = [];
      const task = buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: true, unaligned: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(calls), writeOwnerPrompts: fakeOwnerPrompts(0, sinceMinutes) });
      await task.prepare!();
      expect(await task.run(async () => { throw new Error('no agent needed'); }, 'codex')).toBe('goals unchanged.');
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), priorities: [{ title: 'Ship cards', rank: 1 }] });
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
