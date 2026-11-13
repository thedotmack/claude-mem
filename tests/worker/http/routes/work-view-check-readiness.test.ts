// "Mark checked" has one readiness rule (to-work-model.ts isReadyForCheck). These cases run the page's mapping and the
// worker's review route over the same snapshot, so the page can never offer a check the route refuses.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { isReadyForCheck, toWorkModel } from '../../../../src/ui/my-work/src/live/to-work-model.js';

const SESSIONS = {
  finished: '6f1c2a9e-4b7d-4e0a-9c35-2d8f7a1b0c11',
  running: '7a2d3b0f-5c8e-4f1b-8d46-3e9a8b2c1d22',
  asking: '8b3e4c1a-6d9f-4a2c-9e57-4f0b9c3d2e33',
  unread: '9c4f5d2b-7e0a-4b3d-8f68-5a1c0d4e3f44',
};
const seconds = (ago: number) => new Date(Date.now() - ago * 1000).toISOString();
const jsonl = (records: unknown[]) => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
const prompt = (ago: number) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: 'Build it' }, timestamp: seconds(ago), origin: { kind: 'human' } });
const assistant = (ago: number, stopReason: string, content: unknown[]) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content, stop_reason: stopReason }, timestamp: seconds(ago) });
const answer = (ago: number) => assistant(ago, 'end_turn', [{ type: 'text', text: 'Done.' }]);
const toolUse = (ago: number, name: string) => assistant(ago, 'tool_use', [{ type: 'tool_use', id: 'toolu_1', name, input: {} }]);

let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let nextRow = 1;

function addConversation(id: number, sessionId: string, transcript: unknown[] | null) {
  const asked = Date.now() - 60_000;
  source.prepare('INSERT INTO sdk_sessions (id, project, platform_source, content_session_id, memory_session_id, user_prompt, status, started_at_epoch) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'example-project', 'claude', sessionId, `memory-${id}`, `Build part ${id} of the viewer`, 'active', asked);
  source.prepare('INSERT INTO user_prompts (id, session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?,?,1,?,?)').run(id, id, `Build part ${id} of the viewer`, asked);
  if (transcript) writeFileSync(join(directory, 'claude-projects', '-project', `${sessionId}.jsonl`), jsonl(transcript));
}

function addWork(requestId: string, fields: Record<string, unknown>) {
  source.prepare('INSERT INTO work_state_entries (id, project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?, ?)')
    .run(nextRow++, 'example-project', 'example-work', JSON.stringify({ task: `Build ${requestId}`, request_id: requestId, human_request: `Ask ${requestId}`, ...fields }), Date.now());
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-check-readiness-'));
  mkdirSync(join(directory, 'claude-projects', '-project'), { recursive: true });
  mkdirSync(join(directory, 'codex'));
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
  addConversation(1, SESSIONS.finished, [prompt(30), answer(20)]);
  addConversation(2, SESSIONS.running, [prompt(30), toolUse(20, 'Bash')]);
  addConversation(3, SESSIONS.asking, [prompt(30), toolUse(20, 'AskUserQuestion')]);
  addConversation(4, SESSIONS.unread, null);
  addWork('reported-complete', { status: 'done', request_complete: true });
  addWork('waiting-for-review', { status: 'doing', request_status: 'needs_review' });
  addWork('item-in-review', { status: 'needs-review' });
  addWork('child-done-only', { status: 'done', request_complete: false });
  addWork('still-doing', { status: 'doing' });
  addWork('shipped', { status: 'done', request_status: 'shipped' });
  addWork('blocked', { status: 'blocked' });
  routes = new WorkViewRoutes({
    databasePath: join(directory, 'source.db'), reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null,
    setupStatePath: join(directory, 'setup.json'), transcriptRoots: { claudeProjectsDir: join(directory, 'claude-projects'), codexHome: join(directory, 'codex') },
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  source.close();
  rmSync(directory, { recursive: true, force: true });
});

const snapshot = async () => (await fetch(`${origin}/api/work-view`)).json() as Promise<any>;
const check = (request: any, checked = true) => fetch(`${origin}/api/work-view/review`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({ requestId: request.id, expectedFingerprint: request.contentFingerprint, checked }),
});

describe('Mark checked: the page and the review route', () => {
  it('the route saves every check the page offers, and refuses every check it does not offer', async () => {
    const view = await snapshot();
    const rows = new Map(toWorkModel(view, Date.now()).requests.map(row => [row.id, row]));
    const offered: string[] = [], refused: string[] = [];
    for (const request of view.humanRequests) {
      const row = rows.get(request.id)!;
      // The request page shows Mark checked exactly for this state (request-detail.tsx CheckAction).
      const offers = row.state === 'needs-check';
      const response = await check(request);
      expect([request.id, response.status]).toEqual([request.id, offers ? 200 : 409]);
      (offers ? offered : refused).push(request.id);
    }
    const sessionNames = new Map(Object.entries(SESSIONS).map(([name, session]) => [session, name]));
    const named = (ids: string[]) => ids.map(id => (JSON.parse(id) as string[]).at(-1)!).map(last => sessionNames.get(last) ?? last).sort();
    expect(named(offered)).toEqual(['item-in-review', 'reported-complete', 'waiting-for-review']);
    expect(named(refused)).toEqual(['asking', 'blocked', 'child-done-only', 'finished', 'running', 'shipped', 'still-doing', 'unread']);
  });

  it('a saved check can be repeated and undone', async () => {
    const find = async () => (await snapshot()).humanRequests.find((request: any) => request.id.includes('reported-complete'));
    const complete = await find();
    expect((await check(complete)).status).toBe(200);
    const checked = await find();
    expect(checked.review.checked).toBe(true);
    expect(isReadyForCheck(checked, Date.now())).toBe(true);
    expect((await check(checked)).status).toBe(200);
    expect((await check(checked, false)).status).toBe(200);
    expect((await find()).review.checked).toBe(false);
  });
});
