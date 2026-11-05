import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

// A coordinator session with an async subagent that finished before the
// SubagentStop hook existed: nothing recorded its stop, so only the owner can.
const SUB = 'a1e7d1aa9fa57892a';
let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let nextId: number;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-agent-finished-test-'));
  const databasePath = join(directory, 'source.db');
  source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec(`
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, user_prompt TEXT, custom_title TEXT, status TEXT, started_at_epoch INTEGER, completed_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, content_session_id TEXT, agent_id TEXT, agent_type TEXT, prompt_number INTEGER, title TEXT, subtitle TEXT, type TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, agent_id TEXT, agent_type TEXT, session_db_id INTEGER, memory_session_id TEXT, content_session_id TEXT, prompt_number INTEGER, tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
  `);
  const now = Date.now();
  source.prepare('INSERT INTO sdk_sessions VALUES (1, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)').run('repo', 'claude', 'parent-session', 'memory-parent', 'Build the install funnel', 'active', now - 3_600_000);
  source.prepare('INSERT INTO tool_uses VALUES (1, ?, ?, NULL, NULL, 1, ?, ?, 1, ?, ?, ?, ?)').run('repo', 'claude', 'memory-parent', 'parent-session', 'Agent',
    JSON.stringify({ description: 'Build install funnel phases 4-11' }), JSON.stringify({ isAsync: true, status: 'async_launched', agentId: SUB }), now - 3_000_000);
  source.prepare('INSERT INTO observations VALUES (1, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)').run('repo', 'memory-parent', 'parent-session', SUB, 'general-purpose', 'Captured a Reveal screenshot', 'change', now - 2_000_000);
  nextId = 1;
  routes = new WorkViewRoutes({
    databasePath, reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: join(directory, 'work-view'),
    homeProject: 'home', rulesFilePath: join(directory, 'MY-RULES.md'), claudeInstructionsPath: join(directory, 'CLAUDE.md'),
    appendWorkStateEntry: ({ project, listName, fields }) => {
      source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)').run(nextId++, project, listName, JSON.stringify(fields), Date.now());
    },
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

const snapshot = async () => (await fetch(`${origin}/api/work-view`)).json();
const subagent = (view: any) => view.agents.find((agent: any) => agent.agentId === SUB);
const markFinished = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin }) =>
  fetch(`${origin}/api/work-view/agents/mark-finished`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('Mark finished', () => {
  it('records the owner stop for a subagent no evidence covers, and the view shows it finished', async () => {
    const before = subagent(await snapshot());
    expect(before.presence.status).not.toBe('finished');
    expect(before.canMarkFinished).toBe(true);

    const response = await markFinished({ agentGroupId: before.id });
    expect(response.status).toBe(200);
    const after = subagent(await response.json());
    expect(after.presence).toMatchObject({ status: 'finished', evidence: 'owner-marked-finished' });
    expect(after.canMarkFinished).toBe(false);
    expect(after.work.every((item: any) => !item.isOpen)).toBe(true);

    const row = source.prepare("SELECT project, fields FROM work_state_entries WHERE list_name = 'agent-lifecycle'").get() as { project: string; fields: string };
    expect(row.project).toBe('repo');
    expect(JSON.parse(row.fields)).toMatchObject({ status: 'done', agent_id: SUB, content_session_id: 'parent-session', stop_source: 'owner-marked-finished' });
    // Marking it twice is refused rather than writing a second stop.
    expect((await markFinished({ agentGroupId: before.id })).status).toBe(409);
  });

  it('refuses requests from another origin, malformed bodies, unknown agents and main agents', async () => {
    const view = await snapshot();
    expect((await markFinished({ agentGroupId: subagent(view).id }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await markFinished({})).status).toBe(400);
    expect((await markFinished({ agentGroupId: 'missing' })).status).toBe(404);
    const main = view.agents.find((agent: any) => !agent.isSubagent);
    if (main) expect((await markFinished({ agentGroupId: main.id })).status).toBe(409);
    expect(source.prepare("SELECT COUNT(*) AS count FROM work_state_entries").get()).toEqual({ count: 0 });
  });
});
