import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setFakeSpawn } from '../helpers/fake-spawn.js';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { buildRefreshTask, FOCUS_ANSWER_SCHEMA, GROUPING_ANSWER_SCHEMA, reviewConcurrency, STEP_MODELS } from '../../src/services/work-view/refresh-task.js';
import { readLedger, runCli } from '../../src/services/work-view/request-groups.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';
import { everyRequestInOther, focusInputFrom, focusWriter, isOtherPass } from '../helpers/fake-focus-writer.js';
import { FOCUS_BATCH } from '../../src/services/work-view/request-groups.mjs';
import { readFocus } from '../../src/services/work-view/data-source.mjs';

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
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Focus area: Cards', status: 'todo', goal_kind: 'focus-area', rank: 1, title: 'Cards', goal: 'Release cards people can read.', focus_area_id: 'fa_cards0000001' }), 2);
  write.run('owner', 'owner-goals', JSON.stringify({ task: 'Ask: Ship cards', status: 'todo', goal_kind: 'ask', rank: 1, title: 'Ship cards', focus_area: 'Cards', focus_area_id: 'fa_cards0000001' }), 3);
}

/** The Cards area as the owner-goals save suggested it in My Focus. */
function saveFocusArea(database: Database) {
  database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)').run('owner', 'my-focus', JSON.stringify({
    task: 'Focus area: fa_cards0000001', focus_area_id: 'fa_cards0000001', name: 'Cards', goal: 'Release cards people can read.', status: 'suggested',
    priority_rank: 1, owner_rank: null, source: 'owner-goals', merged_into: null, evidence: null, decided_by: 'system' }), 4);
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
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: handle(database), now: () => now, runJob: job => { jobs.push(job); return finish.promise; } });
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
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: handle(database), now: () => NOW, runJob: async () => { ran = true; return { state: 'ok', agent: null, result: null, error: null }; } });
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
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: handle(fixtureDatabase()), now: () => NOW, runJob: async () => agentInstalled
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
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: handle(database), now: () => NOW, enabled: () => enabled, runJob: async () => ({ state: 'failed', agent: 'gemini', result: null, error: 'gemini exited 1' }) });
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

  it('after failed runs the next scheduled one waits twice as long each time, up to four hours; a run that works resets it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const MINUTE = 60000;
      let now = NOW, works = false, runs = 0;
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: handle(fixtureDatabase()), now: () => now, runJob: async () => {
        runs++;
        return works ? { state: 'ok', agent: 'claude-code', result: 'done', error: null } : { state: 'failed', agent: 'claude-code', result: null, error: 'reviews: g_1: no review was given.' };
      } });
      expect(await worker.check()).toBe('failed');
      expect(worker.status()).toMatchObject({ failures: 1, nextAt: new Date(now + 10 * MINUTE).toISOString() });
      now += 10 * MINUTE;
      expect(await worker.check()).toBe('failed');
      expect(worker.status()).toMatchObject({ failures: 2, nextAt: new Date(now + 20 * MINUTE).toISOString() });
      now += 10 * MINUTE;
      expect(await worker.check()).toBe('backing-off');
      expect(runs).toBe(2);
      now += 10 * MINUTE;
      expect(await worker.check()).toBe('failed');
      expect(worker.status()).toMatchObject({ failures: 3, nextAt: new Date(now + 40 * MINUTE).toISOString() });
      // The wait stops growing at four hours.
      writeFileSync(join(dir, 'refresh.json'), JSON.stringify({ ...worker.status(), failures: 20, nextAt: new Date(now).toISOString() }));
      expect(await worker.check()).toBe('failed');
      expect(worker.status()).toMatchObject({ failures: 21, nextAt: new Date(now + 240 * MINUTE).toISOString() });
      // An explicit run is not held back, and one that works goes back to the ten-minute check.
      works = true;
      expect(await worker.runNow({ reason: 'manual' })).toBe('ok');
      expect(worker.status().failures).toBeUndefined();
      expect(worker.status().nextAt).toBe(new Date(now + 10 * MINUTE).toISOString());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('refresh task', () => {
  it('Claude Code gets only read-only tools: Read, Grep, Glob and memory search, with no Bash, Write or bypass', () => {
    const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 2, ungrouped: 1, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: '/data', ledgerDir: '/data/work-view', pluginRoot: '/plugin', openDatabase: handle(fixtureDatabase()), now: () => NOW });
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
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
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
        const file = /is in (.+?\.json)/.exec(prompt)?.[1];
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
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'One request is under way.', preferences: [] });
        throw new Error(`Unexpected prompt: ${prompt.slice(-200)}`);
      };
      expect(await task.run(ask, 'gemini')).toBe('1 new conversations grouped, 1 requests reviewed, 1 requests placed, story written.');
      const ledger = readLedger(dir);
      expect(Object.values(ledger.groups.groups).map((group: any) => group.title)).toEqual(['Release cards']);
      expect(Object.values(ledger.progress).map((review: any) => review.percent)).toEqual([40]);
      expect(ledger.story.narrative).toBe('One request is under way.');
      // Grouping and the focus step run on the light models; reviews and the story on the careful ones.
      // The focus step asks twice: place the request, then propose from Other (where it landed).
      expect(models).toEqual([STEP_MODELS.grouping, STEP_MODELS.review, STEP_MODELS.review, STEP_MODELS.focus, STEP_MODELS.focus, STEP_MODELS.story]);
      expect(STEP_MODELS.focus).toBe(STEP_MODELS.grouping);
      expect(STEP_MODELS.grouping).toEqual({ 'claude-code': { model: 'haiku' }, codex: { model: 'gpt-6-luna', reasoningEffort: 'low' }, gemini: { model: 'flash-lite' } });
      expect(STEP_MODELS.review).toEqual({ 'claude-code': { model: 'sonnet' }, codex: {}, gemini: { model: 'flash' } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Codex grouping answers', () => {
  const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'codex');
  const groupingTask = (dir: string, database: Database) => buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });

  it('grouping asks for the apply schema, and a schema-shaped Codex answer is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-codex-schema-'));
    try {
      const database = fixtureDatabase();
      const schemas: unknown[] = [];
      const ask = async (prompt: string, _models: unknown, schema?: unknown) => {
        schemas.push(schema);
        if (prompt.includes('Do only section 1')) return readFileSync(join(FIXTURES, 'grouping-answer-schema.txt'), 'utf8');
        if (prompt.includes('Do only section 2')) {
          const [show] = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await groupingTask(dir, database).run(ask, 'codex')).toBe('1 new conversations grouped, 1 requests reviewed, 1 requests placed, story written.');
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
      // A refused answer must not send the run on to another agent (#5189).
      expect((error as { answerRefused?: boolean }).answerRefused).toBe(true);
      // Asked once more with the reason before failing; nothing was grouped.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatch(/Your previous answer was refused: JSON Parse error/);
      expect(Object.keys(readLedger(dir).groups.groups)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('focus step', () => {
  /** Sessions b.. as one-conversation requests beside the fixture's a, applied to the ledger. */
  function requests(database: Database, dir: string, sessions: string[]) {
    sessions.forEach((session, index) => {
      database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(index + 2, 'claude', session, `m${index + 2}`, 'repo/tree', `Build feature ${session}`, NOW - 2 * DAY);
      database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(index + 2, 1, `Build feature ${session}`, NOW - 2 * DAY);
    });
    const decisions = join(dir, 'decisions.json');
    writeFileSync(decisions, JSON.stringify({ groups: ['a', ...sessions].map(session => ({ title: `Request ${session}`, conversations: [key(session)] })) }));
    runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
  }
  const reviewAll = (prompt: string) => {
    const shows = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
    return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis })) });
  };

  it('runs where Align used to, on the light model: places with focus-input inline, then proposes from Other, through the worker\'s write', async () => {
    const dir = scratchDir('auto-refresh-focus');
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW).toISOString());
      saveFocusArea(database);
      requests(database, dir, ['b', 'c']);
      const writer = focusWriter(database);
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 3, ungrouped: 0, goalsStale: false, unplaced: 3, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      const steps: Array<{ prompt: string; models: unknown; schema: unknown }> = [];
      let placeAnswers = 0;
      const ask = async (prompt: string, models: unknown, schema?: unknown) => {
        steps.push({ prompt, models, schema });
        if (prompt.includes('Do only section 2')) return reviewAll(prompt);
        if (isOtherPass(prompt)) {
          const other = focusInputFrom(prompt);
          expect(other.other.map((request: any) => request.anchor)).toEqual([key('b'), key('c')]);
          return JSON.stringify({ placements: [], proposals: [{ kind: 'new', name: 'Polish', goal: 'The release looks finished.', about: 'Spacing and copy fixes.', anchors: [key('b'), key('c')], sameAs: null, evidence: 'Both are steps of finishing the release.' }] });
        }
        if (prompt.includes('Do only section 3')) {
          const input = focusInputFrom(prompt);
          expect(JSON.parse(readFileSync(/also saved in (.+?\.json)/.exec(prompt)![1], 'utf8'))).toEqual(input);
          expect(input.areas.map((area: any) => area.focusAreaId)).toEqual(['fa_cards0000001']);
          expect(input.requests[0]).toMatchObject({ conversations: 1, conversationAsks: ['Build the release cards'] });
          expect(prompt).toContain(`Place each of these 3 requests exactly once, by its "anchor": ${[key('a'), key('b'), key('c')].join(', ')}.`);
          // The first answer names an area id that does not exist: refused by the validator, not filed under Other.
          if (placeAnswers++ === 0) return JSON.stringify({ placements: [{ anchor: key('a'), focusAreaId: 'fa_made_up', evidence: 'x' }, { anchor: key('b'), focusAreaId: 'other', evidence: 'y' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'z' }], proposals: [] });
          expect(prompt).toMatch(/Your previous answer was refused: placements\[0\] names "fa_made_up", which is not a listed focus area/);
          return JSON.stringify({ placements: [{ anchor: key('a'), focusAreaId: 'fa_cards0000001', evidence: 'Release cards are the Cards area.' }, { anchor: key('b'), focusAreaId: 'other', evidence: 'Spacing.' }, { anchor: key('c'), focusAreaId: 'other', evidence: 'Copy.' }], proposals: [] });
        }
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await task.run(ask, 'codex')).toBe('3 requests reviewed, 3 requests placed, 1 focus areas suggested, story written.');
      const focusSteps = steps.filter(step => step.prompt.includes('Do only section 3'));
      expect(focusSteps).toHaveLength(3);
      for (const step of focusSteps) { expect(step.models).toBe(STEP_MODELS.focus); expect(step.schema).toBe(FOCUS_ANSWER_SCHEMA); }
      expect(steps.map(step => /Do only section (\d)/.exec(step.prompt)?.[1] ?? 'review')).toEqual(['2', '3', '3', '3', '4']);
      expect(task.steps.map(timing => timing.step)).toEqual(['review', 'focus', 'focus', 'story']);
      // Only accepted answers reached the worker's write: the placement batch and the Other pass.
      expect(writer.bodies).toHaveLength(2);
      const focus = readFocus(database, { localDeviceId: '' });
      const proposed = focus.focusAreas.find(area => area.name === 'Polish')!;
      expect(proposed).toMatchObject({ status: 'suggested', source: 'clustering', decidedBy: 'system' });
      expect([key('a'), key('b'), key('c')].map(anchor => focus.focusAreaIdByAnchor.get(anchor))).toEqual(['fa_cards0000001', proposed.focusAreaId, proposed.focusAreaId]);
      const objects: any[] = [];
      const walk = (node: any) => { if (node?.type === 'object') objects.push(node); for (const value of Object.values(node ?? {})) if (value && typeof value === 'object') walk(value); };
      walk(FOCUS_ANSWER_SCHEMA);
      expect(objects.length).toBe(3);
      for (const object of objects) { expect(object.additionalProperties).toBe(false); expect(object.required).toEqual(Object.keys(object.properties)); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it(`places in batches of ${FOCUS_BATCH}, each saved before the next; a refused batch fails the step but the story still runs`, async () => {
    const dir = scratchDir('auto-refresh-focus-batches');
    try {
      const database = fixtureDatabase();
      const sessions = Array.from({ length: FOCUS_BATCH }, (_, index) => `s${index}`);
      requests(database, dir, sessions);
      const writer = focusWriter(database);
      const batches: number[] = [];
      let refuseSecond = true;
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 2')) return reviewAll(prompt);
        if (isOtherPass(prompt)) return JSON.stringify({ placements: [], proposals: [] });
        if (prompt.includes('Do only section 3')) {
          const input = focusInputFrom(prompt);
          batches.push(input.requests.length);
          // The second batch's answers keep leaving a request out.
          if (batches.length > 1 && refuseSecond) return JSON.stringify({ placements: [], proposals: [] });
          return everyRequestInOther(prompt);
        }
        return JSON.stringify({ narrative: 'Under way.', preferences: [] });
      };
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: FOCUS_BATCH + 1, ungrouped: 0, goalsStale: false, unplaced: FOCUS_BATCH + 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      const error = await task.run(ask, 'codex').then(() => null, failure => failure as Error);
      expect(error?.message).toMatch(/^focus \(raw answer: .+\): Place every request asked about; missing/);
      expect((error as { answerRefused?: boolean }).answerRefused).toBe(true);
      expect(batches).toEqual([FOCUS_BATCH, 1, 1]);
      // The first batch was saved; the story was written anyway.
      expect(readFocus(database, { localDeviceId: '' }).focusAreaIdByAnchor.size).toBe(FOCUS_BATCH);
      expect(readLedger(dir).story.narrative).toBe('Under way.');
      // The next refresh asks only for the one left.
      refuseSecond = false;
      batches.length = 0;
      const next = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      expect(await next.run(ask, 'codex')).toBe('1 requests placed.');
      expect(batches).toEqual([1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a refused focus answer keeps the run on this agent even when a later crash is the error the runner sees (#5189)', async () => {
    const dir = scratchDir('auto-refresh-refused-then-crash');
    try {
      const database = fixtureDatabase();
      requests(database, dir, Array.from({ length: FOCUS_BATCH }, (_, index) => `s${index}`));
      const writer = focusWriter(database);
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 2')) return reviewAll(prompt);
        if (isOtherPass(prompt)) return JSON.stringify({ placements: [], proposals: [] });
        // Every focus answer leaves requests out, so focus is refused twice.
        if (prompt.includes('Do only section 3')) return JSON.stringify({ placements: [], proposals: [] });
        // The story's agent call itself crashes, which on its own would let the runner try the next agent.
        throw new Error('Claude Code stopped: socket hang up');
      };
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: FOCUS_BATCH + 1, ungrouped: 0, goalsStale: false, unplaced: FOCUS_BATCH + 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      const error = await task.run(ask, 'claude-code').then(() => null, failure => failure as Error);
      expect(error?.message).toBe('Claude Code stopped: socket hang up');
      expect((error as { answerRefused?: boolean }).answerRefused).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an agent crash with no refused answer still lets the runner try the next agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-crash-only-'));
    try {
      const ask = async () => { throw new Error('Claude Code stopped: socket hang up'); };
      const database = fixtureDatabase();
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      const error = await task.run(ask, 'claude-code').then(() => null, failure => failure as Error);
      expect(error?.message).toBe('Claude Code stopped: socket hang up');
      expect((error as { answerRefused?: boolean }).answerRefused).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('nothing to place: no focus question; a worker failure is not re-asked', async () => {
    const dir = scratchDir('auto-refresh-focus-fail');
    try {
      const database = fixtureDatabase();
      requests(database, dir, []);
      let show: any;
      runCli(['show', Object.keys(readLedger(dir).groups.groups)[0]], { dir, database, now: NOW, print: value => { show = value; } });
      writeFileSync(join(dir, 'review.json'), JSON.stringify({ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis }));
      runCli(['record-progress', join(dir, 'review.json')], { dir, database, now: NOW, print: () => {} });
      writeFileSync(join(dir, 'story.json'), JSON.stringify({ narrative: 'Started.', preferences: [], writtenAt: new Date(NOW + 1000).toISOString() }));
      let asked = 0;
      const unavailable = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW,
        saveFocus: () => { throw new Error('Saving the focus step stopped after 1 of 2 rows: disk full'); } });
      const error = await unavailable.run(async prompt => { asked++; return everyRequestInOther(prompt); }, 'codex').then(() => null, failure => failure as Error);
      expect(error?.message).toBe('Saving the focus step stopped after 1 of 2 rows: disk full');
      expect(asked).toBe(1);
      const writer = focusWriter(database);
      const placed = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: 1, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      expect(await placed.run(async prompt => everyRequestInOther(prompt), 'codex')).toBe('1 requests placed.');
      const again = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: writer.save });
      expect(await again.run(async prompt => { throw new Error(`Unexpected prompt: ${prompt.slice(-100)}`); }, 'codex')).toBe('Nothing was due.');
      expect(() => buildRefreshTask({ needs: { due: 0, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database) } as any)).toThrow(/sync device id/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('story repair', () => {
  it('returns the rejected story to the fresh call so it can preserve evidence while shortening it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-story-repair-'));
    const database = fixtureDatabase();
    try {
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }] }));
      runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 1, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      const preferences = [{ preference: 'Show verified results.', kind: 'directive', supportCount: 2, quotes: [] }];
      const rejected = JSON.stringify({ narrative: 'Keep the verified release evidence. ' + 'x'.repeat(12000), preferences });
      let storyAttempts = 0;
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 2')) {
          const [show] = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 40, summary: 'Release cards are being built.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        expect(prompt).toContain('Do only section 4');
        if (storyAttempts++ === 0) return rejected;
        expect(prompt).toContain('Your previous answer was refused:');
        expect(prompt).toContain('12000');
        expect(prompt).toContain(rejected);
        return JSON.stringify({ narrative: 'Verified release evidence retained.', preferences });
      };
      expect(await task.run(ask, 'claude-code')).toBe('1 requests reviewed, 1 requests placed, story written.');
      expect(storyAttempts).toBe(2);
      expect(readLedger(dir).story.narrative).toBe('Verified release evidence retained.');
      expect(readLedger(dir).story.preferences).toEqual(preferences);
    } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review repair', () => {
  it.each(['narrative', 'summary'])('returns the rejected review so an oversized %s can be corrected without repeating accepted groups', async (field) => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-review-repair-'));
    const database = fixtureDatabase();
    try {
      database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 'claude', 'b', 'm2', 'repo/tree', 'Build another feature', NOW - 2 * DAY);
      database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(2, 1, 'Build another feature', NOW - 2 * DAY);
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: ['a', 'b'].map(session => ({ title: `Feature ${session}`, conversations: [key(session)] })) }));
      runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
      const refresh = buildRefreshTask({ localDeviceId: () => '', needs: { due: 2, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      const oversized = 'Retain the evidence while shortening this review. ' + 'x'.repeat(1257);
      let attempts = 0, rejectedReview: any, acceptedId = '';
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'Work continues.' });
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const shows = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        attempts++;
        if (attempts === 1) {
          expect(shows).toHaveLength(2);
          acceptedId = shows[0].groupId;
          rejectedReview = { groupId: shows[1].groupId, state: 'in-progress', percent: 30, summary: 'Under way.', [field]: oversized, evidence: ['observation 42'], reviewBasis: shows[1].reviewBasis };
          return JSON.stringify({ reviews: [{ groupId: acceptedId, state: 'in-progress', percent: 10, summary: 'Already accepted review.', reviewBasis: shows[0].reviewBasis }, rejectedReview] });
        }
        expect(shows.map((show: any) => show.groupId)).toEqual([rejectedReview.groupId]);
        expect(prompt).toContain(JSON.stringify(rejectedReview));
        expect(prompt).not.toContain('Already accepted review.');
        return JSON.stringify({ reviews: [{ ...rejectedReview, [field]: 'Evidence preserved in a shorter review.' }] });
      };
      expect(await refresh.run(ask, 'claude-code')).toBe('2 requests reviewed, 2 requests placed, story written.');
      expect(attempts).toBe(2);
      const progress = readLedger(dir).progress;
      expect(progress[rejectedReview.groupId][field]).toBe('Evidence preserved in a shorter review.');
      expect(progress[rejectedReview.groupId].evidence).toEqual(['observation 42']);
      expect(progress[acceptedId].readings).toHaveLength(1);
    } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
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
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 10, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      let inFlight = 0, most = 0;
      const bothAsked = deferred<void>();
      let lastPrompt = '';
      const ask = async (prompt: string) => {
        lastPrompt = prompt;
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'Ten features under way.' });
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const shows = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        most = Math.max(most, ++inFlight);
        if (most === 2) bothAsked.resolve();
        await bothAsked.promise;
        inFlight--;
        return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 30, summary: 'Under way.', reviewBasis: show.reviewBasis })) });
      };
      expect(await task.run(ask, 'claude-code')).toBe('10 requests reviewed, 10 requests placed, story written.');
      expect(lastPrompt).toMatch(/Search claude-mem memory with its MCP tools/);
      expect(most).toBe(2);
      // refresh.json's run record gets one timing per step and review batch.
      expect(task.steps.map(timing => [timing.step, timing.agent, timing.groups])).toEqual([['review', 'claude-code', 8], ['review', 'claude-code', 2], ['focus', 'claude-code', undefined], ['focus', 'claude-code', undefined], ['story', 'claude-code', undefined]]);
      expect(task.steps.every(timing => timing.startedAt === new Date(NOW).toISOString() && timing.finishedAt === timing.startedAt)).toBe(true);
      expect(Object.keys(readLedger(dir).progress)).toHaveLength(10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an invalid CLAUDE_MEM_MAX_CONCURRENT_AGENTS never leaves zero review lanes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-lanes-'));
    const saved = process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS;
    try {
      const lanesWith = (file: string | null, environment: string | undefined) => {
        if (file === null) rmSync(join(dir, 'settings.json'), { force: true });
        else writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_MAX_CONCURRENT_AGENTS: file }));
        if (environment === undefined) delete process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS;
        else process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS = environment;
        return reviewConcurrency(dir);
      };
      for (const invalid of ['0', '-1', 'many']) {
        expect(lanesWith(invalid, invalid)).toBe(2);
        expect(lanesWith(null, invalid)).toBe(2);
        expect(lanesWith(invalid, '4')).toBe(4);
      }
      expect(lanesWith('3', undefined)).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS;
      else process.env.CLAUDE_MEM_MAX_CONCURRENT_AGENTS = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a large backlog runs at most CLAUDE_MEM_MAX_CONCURRENT_AGENTS batches at once, and every batch is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-parallel-'));
    try {
      const database = fixtureDatabase();
      const sessions = Array.from({ length: 39 }, (_, index) => `s${index}`);
      sessions.forEach((session, index) => {
        database.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(index + 2, 'claude', session, `m${index + 2}`, 'repo/tree', `Build feature ${session}`, NOW - 2 * DAY);
        database.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(index + 2, 1, `Build feature ${session}`, NOW - 2 * DAY);
      });
      const decisions = join(dir, 'decisions.json');
      writeFileSync(decisions, JSON.stringify({ groups: ['a', ...sessions].map(session => ({ title: `Feature ${session}`, conversations: [key(session)] })) }));
      runCli(['apply', decisions], { dir, database, now: NOW, print: () => {} });
      // The owner's agent-subprocess cap sets the lanes; 3 here so the bound differs from the default of 2.
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '3' }));
      const lanes = reviewConcurrency(dir);
      expect(lanes).toBe(3);
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 40, ungrouped: 0, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      let inFlight = 0, most = 0;
      const lanesFull = deferred<void>();
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 4')) return JSON.stringify({ narrative: 'Forty features under way.' });
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        const shows = JSON.parse(readFileSync(/is in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        most = Math.max(most, ++inFlight);
        if (inFlight === lanes) lanesFull.resolve();
        await lanesFull.promise;
        inFlight--;
        return JSON.stringify({ reviews: shows.map((show: any) => ({ groupId: show.groupId, state: 'in-progress', percent: 30, summary: 'Under way.', reviewBasis: show.reviewBasis })) });
      };
      expect(await task.run(ask, 'claude-code')).toBe('40 requests reviewed, 40 requests placed, story written.');
      expect(most).toBe(lanes);
      expect(task.steps.filter(timing => timing.step === 'review')).toHaveLength(5);
      expect(Object.keys(readLedger(dir).progress)).toHaveLength(40);
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
      // The interpreter probe (`python3 -c ...`): answer "Python 3.9+" without recording a script call.
      if (args.includes('-c')) {
        queueMicrotask(() => child.emit('close', 0));
        return child;
      }
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
      saveFocusArea(database);
      // A rule the last save put in the story comes back to the model with the saved goals.
      writeFileSync(join(dir, 'story.json'), JSON.stringify({ preferences: [{ preference: 'Ship daily.', when: '', kind: 'directive', supportCount: 2, source: 'owner-goals',
        quotes: [{ quote: 'ship it daily', at: new Date(NOW - 3 * DAY).toISOString() }] }, { preference: 'The story\'s own.', quotes: [] }] }));
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      let clock = NOW;
      const calls: Array<{ args: string[]; goals?: any }> = [], sinceMinutes: Array<string | null> = [];
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => clock, spawnImpl: fakePython(calls), writeOwnerPrompts: fakeOwnerPrompts(3, sinceMinutes) });
      await task.prepare!();
      const prompts: string[] = [];
      const ask = async (prompt: string) => {
        prompts.push(prompt);
        // The agent takes five minutes; a prompt typed meanwhile is not in this export.
        clock += 5 * 60000;
        const previous = JSON.parse(readFileSync(/saved goals are in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        expect(previous.focus_areas).toMatchObject([{ title: 'Cards', goal: 'Release cards people can read.', matches: 'fa_cards0000001' }]);
        expect(previous.asks).toMatchObject([{ title: 'Ship cards', focus_area: 'Cards' }]);
        expect(previous.rules).toEqual([{ when: '', then: 'Ship daily.', times_asked: 2, latest_at: new Date(NOW - 3 * DAY).toLocaleString('sv').slice(0, 16),
          evidence: [{ at: new Date(NOW - 3 * DAY).toLocaleString('sv').slice(0, 16), quote: 'ship it daily' }] }]);
        // The saved My Focus areas are supplied for the model's match judgment.
        const areas = JSON.parse(readFileSync(/saved in My Focus are in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        expect(areas.map((area: any) => [area.focusAreaId, area.name])).toEqual([['fa_cards0000001', 'Cards']]);
        // The stubbed answer, in the new shape: a new area beside the matched one, an ask under it and a rule.
        return JSON.stringify({ ...previous,
          focus_areas: [{ ...previous.focus_areas[0], rank: 2 }, { rank: 1, title: 'Pricing', goal: 'A pricing page people trust.', matches: null, latest_at: '2026-10-01 10:00', times_asked: 1, evidence: [{ at: '2026-10-01 10:00', quote: 'pricing' }] }],
          asks: [...previous.asks, { rank: 2, title: 'Pricing page', focus_area: 'Pricing', latest_at: '2026-10-01 10:00', times_asked: 1, evidence: [{ at: '2026-10-01 10:00', quote: 'pricing' }] }] });
      };
      expect(await task.run(ask, 'codex')).toBe('goals updated.');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('new-owner-prompts.md');
      expect(prompts[0]).toContain('3 prompts the owner typed since');
      expect(sinceMinutes).toEqual([new Date(NOW - 2 * DAY).toLocaleString('sv').slice(0, 16)]);
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 40,
        focus_areas: [{ title: 'Cards', rank: 2, matches: 'fa_cards0000001' }, { title: 'Pricing', matches: null }], asks: [{ title: 'Ship cards' }, { title: 'Pricing page', focus_area: 'Pricing' }], rules: [{ then: 'Ship daily.' }] });
      expect(calls[0].args.slice(calls[0].args.indexOf('--ledger-dir'), calls[0].args.indexOf('--ledger-dir') + 2)).toEqual(['--ledger-dir', dir]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an empty history saves an empty snapshot without any model call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-empty-goals-'));
    try {
      const database = fixtureDatabase();
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [];
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(calls), writeOwnerPrompts: async (folder, sinceMinute) => ({ ...await fakeOwnerPrompts(0, [])(folder, sinceMinute), ownerPrompts: 0 }) });
      await task.prepare!();
      expect(await task.run(async () => { throw new Error('empty input must not call a model'); }, 'codex')).toBe('goals empty.');
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), source_prompt_count: 0, focus_areas: [], asks: [], rules: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refreshes goals with python when python3 is not installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-python-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [], sinceMinutes: Array<string | null> = [];
      const python = fakePython(calls);
      const scripts: string[] = [];
      let probes = 0;
      const spawnImpl = ((command: string, args: string[], spawnOptions: any) => {
        if (command !== 'python') throw Object.assign(new Error(`Executable not found: ${command}`), { code: 'ENOENT' });
        if (args.includes('-c')) probes++;
        else {
          scripts.push(command);
          expect(spawnOptions.env.PYTHONUTF8).toBe('1');
          expect(spawnOptions.env.CLAUDE_MEM_INTERNAL).toBe('1');
        }
        return python(command, args, spawnOptions);
      }) as any;
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl, writeOwnerPrompts: fakeOwnerPrompts(0, sinceMinutes) });
      await task.prepare!();
      expect(await task.run(async () => { throw new Error('no agent needed'); }, 'codex')).toBe('goals unchanged.');
      // The export runs in TypeScript; only save_goals.py goes through Python.
      expect(scripts).toEqual(['python']);
      expect(probes).toBe(1);
      expect(calls[0].args[0]).toEndWith('save_goals.py');
      expect(calls[0].goals).toMatchObject({ focus_areas: [{ title: 'Cards' }], asks: [{ title: 'Ship cards' }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not retry a failing save script with another interpreter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-python-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const scripts: Array<{ command: string; script: string }> = [];
      const spawnImpl = ((command: string, args: string[]) => {
        const child: any = new EventEmitter();
        child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
        child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
        const probe = args.includes('-c');
        queueMicrotask(() => {
          if (!probe) { scripts.push({ command, script: args[0] }); child.stderr.emit('data', 'save failed'); }
          child.emit('close', probe ? 0 : 7);
        });
        return child;
      }) as any;
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl, writeOwnerPrompts: fakeOwnerPrompts(0, []) });
      await task.prepare!();
      await expect(task.run(async () => { throw new Error('no agent needed'); }, 'codex')).rejects.toThrow('save_goals.py exited 7: save failed');
      expect(scripts).toHaveLength(1);
      expect(scripts[0].command).toBe('python3');
      expect(scripts[0].script).toEndWith('save_goals.py');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('with no new prompts, re-saves the saved goals without asking an agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-goals-'));
    try {
      const database = fixtureDatabase();
      saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [], sinceMinutes: Array<string | null> = [];
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(calls), writeOwnerPrompts: fakeOwnerPrompts(0, sinceMinutes) });
      await task.prepare!();
      expect(await task.run(async () => { throw new Error('no agent needed'); }, 'codex')).toBe('goals unchanged.');
      expect(calls[0].goals).toMatchObject({ generated_at: new Date(NOW).toISOString(), focus_areas: [{ title: 'Cards', rank: 1, matches: 'fa_cards0000001' }], asks: [{ title: 'Ship cards', rank: 1 }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-asks the model after a save refused before writing (exit 1), never after one that failed while writing (exit 3)', async () => {
    for (const [exits, expected] of [[[1, 0], 2], [[3], 1]] as const) {
      const dir = scratchDir('auto-refresh-save-retry');
      try {
        const database = fixtureDatabase();
        saveGoals(database, new Date(NOW - 2 * DAY).toISOString());
        writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
        const codes = [...exits];
        const spawnImpl = ((_command: string, args: string[]) => {
          const child: any = new EventEmitter();
          child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
          child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
          const probe = args.includes('-c');
          const code = probe ? 0 : codes.shift()!;
          queueMicrotask(() => { if (code) child.stderr.emit('data', code === 3 ? 'failed after writing' : 'a quote is not the owner\'s words'); child.emit('close', code); });
          return child;
        }) as any;
        const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl, writeOwnerPrompts: fakeOwnerPrompts(2, []) });
        await task.prepare!();
        let asked = 0;
        const ask = async (prompt: string) => { asked++; return readFileSync(/saved goals are in (.+?\.json)/.exec(prompt)![1], 'utf8'); };
        if (expected === 2) expect(await task.run(ask, 'codex')).toBe('goals updated.');
        else await expect(task.run(ask, 'codex')).rejects.toThrow('save_goals.py exited 3: failed after writing');
        expect(asked).toBe(expected);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('goals saved as priorities and open asks are sorted again with the three tests, even with nothing new typed', async () => {
    const dir = scratchDir('auto-refresh-resort');
    try {
      const database = fixtureDatabase();
      const write = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
      write.run('owner', 'owner-goals', JSON.stringify({ human_summary: 'Ship the cards.', generated_at: new Date(NOW - 2 * DAY).toISOString() }), 1);
      write.run('owner', 'owner-goals', JSON.stringify({ task: 'Priority: Ship cards', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Ship cards', evidence: '2026-10-01 10:00 | ship the cards' }), 2);
      write.run('owner', 'owner-goals', JSON.stringify({ task: 'Open ask: Never ask me twice', status: 'todo', goal_kind: 'open-ask', rank: 1, title: 'Never ask me twice', evidence: '2026-10-01 10:05 | never ask me twice' }), 3);
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups: {}, ignored: { [key('a')]: 'not a goal' } }));
      const calls: Array<{ args: string[]; goals?: any }> = [];
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 0, goalsStale: true, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, spawnImpl: fakePython(calls), writeOwnerPrompts: fakeOwnerPrompts(0, []) });
      await task.prepare!();
      const prompts: string[] = [];
      const ask = async (prompt: string) => {
        prompts.push(prompt);
        const previous = JSON.parse(readFileSync(/saved goals are in (.+?\.json)/.exec(prompt)![1], 'utf8'));
        expect(previous.focus_areas).toMatchObject([{ title: 'Ship cards', goal: null, matches: null }]);
        expect(previous.asks).toMatchObject([{ title: 'Never ask me twice', focus_area: null }]);
        // The stubbed answer: the old priority is an ask under a new Cards area, and the old open ask is a rule.
        return JSON.stringify({ generated_at: previous.generated_at, human_summary: previous.human_summary,
          focus_areas: [{ rank: 1, title: 'Cards', goal: 'Release cards people can read.', matches: null, latest_at: '2026-10-01 10:00', times_asked: 1, evidence: previous.focus_areas[0].evidence }],
          asks: [{ rank: 1, title: 'Ship cards', focus_area: 'Cards', latest_at: '2026-10-01 10:00', times_asked: 1, evidence: previous.focus_areas[0].evidence }],
          rules: [{ when: '', then: 'Do not ask the owner the same question twice.', latest_at: '2026-10-01 10:05', times_asked: 1, evidence: previous.asks[0].evidence }] });
      };
      expect(await task.run(ask, 'codex')).toBe('goals updated.');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Apply the three tests to every saved item again');
      expect(calls[0].goals).toMatchObject({ focus_areas: [{ title: 'Cards', matches: null }], asks: [{ title: 'Ship cards', focus_area: 'Cards' }], rules: [{ then: 'Do not ask the owner the same question twice.' }] });
      expect(calls[0].goals).not.toHaveProperty('priorities');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('automatic refresh timer', () => {
  it('a check that cannot read the database is logged, not thrown, and the timer keeps going', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-refresh-'));
    try {
      const logs: string[] = [];
      const worker = new AutoRefreshWorker({ localDeviceId: () => '', dir, openDatabase: () => { throw new Error('unable to open database file'); }, runJob: async () => ({ state: 'ok', agent: null, result: null, error: null }), log: (_level, message, data) => { logs.push(`${message}: ${data?.error}`); } });
      worker.start();
      await new Promise(resolve => setImmediate(resolve));
      worker.close();
      expect(logs).toEqual(['Work view refresh check failed: unable to open database file']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
