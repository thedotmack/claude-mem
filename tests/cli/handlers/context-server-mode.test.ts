// SPDX-License-Identifier: Apache-2.0
//
// Plan-24 step 4, test-matrix row "server | SessionStart hook": with
// CLAUDE_MEM_RUNTIME=server and the worker port held by an unrelated listener,
// session-start context comes back from the shared server in under 5 s, and no
// local worker is started or probed (#2991, #3227).
//
// Runs the real hook entry points (`worker-service.ts hook claude-code context`
// and `worker-service.ts start`) in a subprocess against a fake /v1/context
// server, so settings loading, runtime selection, the ServerClient and the
// session-start renderer are all the production code paths. The unrelated
// listener counts connections: any worker health probe or /api/context/inject
// call would show up there.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server as NetServer, type Socket } from 'net';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const WORKER_SERVICE = join(import.meta.dir, '../../../src/services/worker-service.ts');
const HOOK_BUDGET_MS = 5_000;

interface RecordedContextRequest {
  authorization: string | null;
  body: Record<string, unknown>;
}

let rootDir: string;
let dataDir: string;
let projectDir: string;
let projectName: string;
let unrelatedListener: NetServer;
let workerPort: number;
let workerPortConnections: number;
let openSockets: Socket[];
let fakeServer: ReturnType<typeof Bun.serve> | null;
let contextRequests: RecordedContextRequest[];

function serverRows(project: string): Array<Record<string, unknown>> {
  const now = Date.now();
  return [
    {
      id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
      projectId: 'server-project-1',
      teamId: 'team-1',
      serverSessionId: 'b1d2c3e4-0000-4000-8000-000000000001',
      kind: 'bugfix',
      content: 'Fixed the import batch abort',
      metadata: { title: 'Import no longer aborts on a bad row', project },
      createdAtEpoch: now - 120_000,
      updatedAtEpoch: now - 120_000,
    },
    {
      id: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      projectId: 'server-project-1',
      teamId: 'team-1',
      serverSessionId: 'b1d2c3e4-0000-4000-8000-000000000001',
      kind: 'summary',
      content: 'summary body',
      metadata: { request: 'Stop one bad row from aborting the restore', project },
      createdAtEpoch: now - 60_000,
      updatedAtEpoch: now - 60_000,
    },
  ];
}

function startFakeServer(): string {
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/context') {
        const body = (await request.json()) as Record<string, unknown>;
        contextRequests.push({ authorization: request.headers.get('authorization'), body });
        const observations = serverRows(projectName);
        return Response.json({
          observations,
          context: observations.map(row => row.content).join('\n\n'),
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return `http://127.0.0.1:${fakeServer.port}`;
}

function writeSettings(serverBaseUrl: string, overrides: Record<string, string> = {}): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_RUNTIME: 'server',
    CLAUDE_MEM_SERVER_URL: serverBaseUrl,
    CLAUDE_MEM_SERVER_API_KEY: 'cmem_test_key',
    CLAUDE_MEM_SERVER_PROJECT_ID: 'server-project-1',
    CLAUDE_MEM_WORKER_PORT: String(workerPort),
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    ...overrides,
  }, null, 2));
}

// A server that accepts the /v1/context request and never answers it.
function startHangingServer(): string {
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/context') {
        contextRequests.push({ authorization: request.headers.get('authorization'), body: await request.json() as Record<string, unknown> });
        return new Promise<Response>(() => {});
      }
      return new Response('not found', { status: 404 });
    },
  });
  return `http://127.0.0.1:${fakeServer.port}`;
}

// The parent test process may carry the developer's CLAUDE_MEM_* overrides;
// settings for the hook come only from the temp settings.json.
function hookEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CLAUDE_MEM_')) env[key] = value;
  }
  env.CLAUDE_MEM_DATA_DIR = dataDir;
  env.CLAUDE_CONFIG_DIR = join(rootDir, 'claude-config');
  env.DO_NOT_TRACK = '1';
  return env;
}

async function runWorkerService(
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; elapsedMs: number }> {
  const startedAt = Date.now();
  const child = Bun.spawn([process.execPath, WORKER_SERVICE, ...args], {
    cwd: projectDir,
    env: hookEnv(),
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, elapsedMs: Date.now() - startedAt };
}

function sessionStartInput(source = 'startup'): string {
  return JSON.stringify({
    session_id: 'session-start-server-runtime',
    cwd: projectDir,
    hook_event_name: 'SessionStart',
    source,
  });
}

// plugin/hooks/codex-hooks.json: Codex kills a SessionStart hook after 20 s and
// drops its output.
const CODEX_SESSION_START_LIMIT_MS = 20_000;

function parseHookOutput(stdout: string): {
  hookSpecificOutput?: { additionalContext?: string };
  systemMessage?: string;
} {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line);
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'cm-session-start-server-'));
  dataDir = join(rootDir, 'data');
  projectDir = join(rootDir, 'session-start-repo');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(rootDir, 'claude-config'), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  projectName = basename(projectDir);
  contextRequests = [];
  fakeServer = null;

  // Something other than a worker owns the worker port: it accepts
  // connections and never answers, like the MCP server in plan-24's report.
  workerPortConnections = 0;
  openSockets = [];
  unrelatedListener = createServer(socket => {
    workerPortConnections += 1;
    openSockets.push(socket);
  });
  await new Promise<void>(resolve => unrelatedListener.listen(0, '127.0.0.1', resolve));
  const address = unrelatedListener.address();
  if (!address || typeof address === 'string') throw new Error('no port for the unrelated listener');
  workerPort = address.port;
});

afterEach(async () => {
  fakeServer?.stop(true);
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>(resolve => unrelatedListener.close(() => resolve()));
  rmSync(rootDir, { recursive: true, force: true });
});

describe('SessionStart in server runtime (plan-24 step 4)', () => {
  it('returns no timeline on Claude resume without reading the server or worker', async () => {
    writeSettings(startFakeServer());

    const result = await runWorkerService(['hook', 'claude-code', 'context'], sessionStartInput('resume'));

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
    expect(workerPortConnections).toBe(0);
    expect(contextRequests).toEqual([]);
    expect(parseHookOutput(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    });
  }, 30_000);

  it('renders the shared server\'s rows in under 5 s without touching the worker port', async () => {
    const serverBaseUrl = startFakeServer();
    writeSettings(serverBaseUrl);

    const result = await runWorkerService(['hook', 'claude-code', 'context'], sessionStartInput());

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
    expect(workerPortConnections).toBe(0);

    const output = parseHookOutput(result.stdout);
    const additionalContext = output.hookSpecificOutput?.additionalContext ?? '';
    // Rendered through the local renderer and budget, not the route's raw
    // pre-joined `context` string.
    expect(additionalContext).toContain(`# [${projectName}] recent context`);
    expect(additionalContext).toContain('Import no longer aborts on a bad row');
    expect(additionalContext).toContain('Stop one bad row from aborting the restore');
    expect(additionalContext).not.toContain('Fixed the import batch abort\n\nsummary body');

    // The terminal copy links the viewer the server serves, not a local worker.
    expect(output.systemMessage ?? '').toContain(`View Observations Live @ ${serverBaseUrl}`);
    expect(output.systemMessage ?? '').not.toContain(`localhost:${workerPort}`);

    // ONE recency read (no query key) per session start, scoped to this folder
    // and platform and sent with the server API key. The model block and the
    // colored terminal copy both render from its rows (#3227 read twice).
    expect(contextRequests.length).toBe(1);
    const [request] = contextRequests;
    expect(request.authorization).toBe('Bearer cmem_test_key');
    expect(request.body.projectId).toBe('server-project-1');
    expect('query' in request.body).toBe(false);
    expect(request.body.folderProjects).toEqual([projectName]);
    expect(request.body.platformSource).toBe('claude');
    // CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY defaults on: subagent rows stay out.
    expect(request.body.excludeSubagents).toBe(true);
  }, 30_000);

  it('asks the server for subagent rows too when CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY is false', async () => {
    writeSettings(startFakeServer(), { CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: 'false' });

    const result = await runWorkerService(['hook', 'claude-code', 'context'], sessionStartInput());

    expect(result.exitCode).toBe(0);
    expect(contextRequests.length).toBe(1);
    expect(contextRequests[0].body.excludeSubagents).toBe(false);
  }, 30_000);

  it('answers a Codex SessionStart inside Codex\'s 20 s hook limit when the server never responds', async () => {
    // The client's default request timeout is 30 s; Codex would kill the hook
    // at 20 s and discard its output, context and all.
    writeSettings(startHangingServer());

    const result = await runWorkerService(['hook', 'codex', 'context'], sessionStartInput());

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(CODEX_SESSION_START_LIMIT_MS);
    expect(contextRequests.length).toBe(1);
    expect(workerPortConnections).toBe(0);
    // Still the valid (empty) SessionStart payload Codex's validator accepts.
    const output = parseHookOutput(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('recent context');
  }, 45_000);

  it('returns an empty block quickly when the server cannot answer, with no stale local rows', async () => {
    // Nothing listens here: the server is down.
    const downServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const downUrl = `http://127.0.0.1:${downServer.port}`;
    downServer.stop(true);
    writeSettings(downUrl);

    const result = await runWorkerService(['hook', 'claude-code', 'context'], sessionStartInput());

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
    expect(workerPortConnections).toBe(0);
    const output = parseHookOutput(result.stdout);
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('recent context');
  }, 30_000);

  it('`start` reports ready without starting or probing a local worker', async () => {
    writeSettings(startFakeServer());

    const result = await runWorkerService(['start']);

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
    expect(workerPortConnections).toBe(0);
    expect(parseHookOutput(result.stdout)).toMatchObject({ continue: true, status: 'ready' });
  }, 30_000);
});
