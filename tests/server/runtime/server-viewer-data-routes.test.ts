// SPDX-License-Identifier: Apache-2.0
//
// The viewer's worker-shaped read endpoints on the server runtime: shapes the
// viewer parses, and API-key auth with team/project scoping.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerViewerRoutes, STREAM_KEEPALIVE_MS, type ServerViewerRoutesOptions } from '../../../src/server/runtime/ServerViewerRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('ServerViewerRoutes data endpoints', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server | null = null;
  let baseUrl: string;
  let teamId: string;
  let teamKey: string;
  let projectKey: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  async function startServer(options: Omit<ServerViewerRoutesOptions, 'pool'> = {}, routesPool: unknown = pool): Promise<void> {
    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: () => Promise.resolve(),
      onRestart: () => Promise.resolve(),
      workerPath: '',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerViewerRoutes({ pool: routesPool as never, authMode: 'api-key', ...options }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function get(path: string, key?: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, key ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
  }

  async function createKey(input: { teamId: string; projectId: string | null; scopes: string[] }): Promise<string> {
    const { raw, hash } = newApiKey();
    await storage.auth.createApiKey({ keyHash: hash, actorId: 'test', ...input });
    return raw;
  }

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_viewer_routes_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId: team.id, name: 'server-project' });
    const otherProject = await storage.projects.create({ teamId: team.id, name: 'other-project' });
    const otherTeam = await storage.teams.create({ name: 'other-team' });
    const foreignProject = await storage.projects.create({ teamId: otherTeam.id, name: 'foreign-project' });

    const session = await storage.sessions.create({
      projectId: project.id,
      teamId: team.id,
      contentSessionId: 'content-session-1',
      platformSource: 'codex',
      metadata: { project: 'repo-a', prompt: 'Fix the login redirect' },
    });

    await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      serverSessionId: session.id,
      kind: 'bugfix',
      content: 'Fixed login redirect loop.',
      metadata: {
        title: 'Login redirect fixed',
        narrative: 'The callback dropped the return URL.',
        facts: ['return URL was dropped'],
        files_modified: ['/repo-a/src/auth.ts'],
        project: 'repo-a',
      },
    });
    await storage.observations.create({
      projectId: project.id,
      teamId: team.id,
      serverSessionId: session.id,
      kind: 'summary',
      content: 'Session summary.',
      metadata: { request: 'Fix login', completed: 'Redirect fixed', next_steps: 'Add a test' },
    });
    // No session and no folder label: falls back to the server project name.
    await storage.observations.create({
      projectId: otherProject.id,
      teamId: team.id,
      kind: 'manual',
      content: 'A manual note.',
    });
    await storage.observations.create({
      projectId: foreignProject.id,
      teamId: otherTeam.id,
      kind: 'discovery',
      content: 'Another team must never see this.',
      metadata: { title: 'Foreign row' },
    });

    teamKey = await createKey({ teamId: team.id, projectId: null, scopes: ['memories:read', 'memories:write'] });
    projectKey = await createKey({ teamId: team.id, projectId: project.id, scopes: ['memories:read'] });
  });

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* already closed */ }
    }
    server = null;
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  it('requires an API key by default', async () => {
    await startServer();
    for (const path of ['/api/projects', '/api/observations', '/api/summaries', '/api/sessions', '/api/processing-status', '/api/logs', '/stream']) {
      const res = await get(path);
      expect(res.status).toBe(401);
    }
  });

  it('serves observations in the viewer shape, scoped to the key team', async () => {
    await startServer();
    const res = await get('/api/observations', teamKey);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>>; hasMore: boolean };
    expect(body.hasMore).toBe(false);
    expect(body.items.map(item => item.text)).toEqual(['A manual note.', 'Fixed login redirect loop.']);

    const bugfix = body.items.find(item => item.type === 'bugfix')!;
    expect(bugfix.project).toBe('repo-a');
    expect(bugfix.platform_source).toBe('codex');
    expect(bugfix.content_session_id).toBe('content-session-1');
    expect(bugfix.title).toBe('Login redirect fixed');
    expect(bugfix.narrative).toBe('The callback dropped the return URL.');
    expect(bugfix.facts).toBe(JSON.stringify(['return URL was dropped']));
    expect(bugfix.files_modified).toBe(JSON.stringify(['/repo-a/src/auth.ts']));
    expect(typeof bugfix.created_at_epoch).toBe('number');

    const manual = body.items.find(item => item.type === 'manual')!;
    expect(manual.project).toBe('other-project');
    expect(manual.platform_source).toBe('claude');
  });

  // Same rule as /v1: the local-dev loopback bypass carries only the configured
  // team, and a request bound to no team is refused rather than read every team.
  it('scopes local-dev bypass requests to the configured team and refuses them without one', async () => {
    await startServer({ authMode: 'local-dev', allowLocalDevBypass: true });
    expect((await get('/api/observations')).status).toBe(403);
    expect((await get('/api/projects')).status).toBe(403);
    try { await server!.close(); } catch { /* already closed */ }
    server = null;

    await startServer({ authMode: 'local-dev', allowLocalDevBypass: true, localDevTeamId: teamId });
    const res = await get('/api/observations');
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ text: string }> };
    expect(body.items.map(item => item.text)).toEqual(['A manual note.', 'Fixed login redirect loop.']);
    const catalog = await (await get('/api/projects')).json() as { projects: string[] };
    expect(catalog.projects).not.toContain('foreign-project');
  });

  it('narrows to the key project for a project-bound key', async () => {
    await startServer();
    const body = await (await get('/api/observations', projectKey)).json() as { items: Array<{ text: string }> };
    expect(body.items.map(item => item.text)).toEqual(['Fixed login redirect loop.']);
  });

  it('filters by project label and session, and pages with hasMore', async () => {
    await startServer();
    const byProject = await (await get('/api/observations?project=repo-a', teamKey)).json() as { items: unknown[] };
    expect(byProject.items).toHaveLength(1);

    const bySession = await (await get('/api/observations?contentSessionId=content-session-1&platformSource=codex', teamKey)).json() as { items: unknown[] };
    expect(bySession.items).toHaveLength(1);

    const firstPage = await (await get('/api/observations?limit=1', teamKey)).json() as { items: unknown[]; hasMore: boolean };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await (await get('/api/observations?limit=1&offset=1', teamKey)).json() as { items: unknown[]; hasMore: boolean };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it('refuses a page size past the ceiling, naming it, instead of clamping', async () => {
    await startServer();
    for (const path of ['/api/observations?limit=101', '/api/summaries?limit=101', '/api/sessions?limit=101', '/api/observations?limit=0']) {
      const res = await get(path, teamKey);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('BadRequest');
      expect(body.message).toContain('100');
    }
    expect((await get('/api/observations?limit=100', teamKey)).status).toBe(200);
  });

  it('serves summaries, sessions, the project catalog and processing status', async () => {
    await startServer();
    const summaries = await (await get('/api/summaries', teamKey)).json() as { items: Array<Record<string, unknown>> };
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0]).toMatchObject({ project: 'repo-a', request: 'Fix login', completed: 'Redirect fixed', next_steps: 'Add a test' });

    const sessions = await (await get('/api/sessions', teamKey)).json() as { sessions: Array<Record<string, unknown>>; hasMore: boolean };
    expect(sessions.sessions).toEqual([expect.objectContaining({
      content_session_id: 'content-session-1',
      project: 'repo-a',
      platform_source: 'codex',
      custom_title: 'Fix the login redirect',
      item_count: 2,
    })]);

    const catalog = await (await get('/api/projects', teamKey)).json() as { projects: string[]; sources: string[]; projectsBySource: Record<string, string[]> };
    expect(catalog.projects.sort()).toEqual(['other-project', 'repo-a']);
    expect(catalog.projectsBySource.codex).toEqual(['repo-a']);
    expect(catalog.projectsBySource.claude).toEqual(['other-project']);
    expect(catalog.projects).not.toContain('foreign-project');

    const status = await (await get('/api/processing-status', teamKey)).json();
    expect(status).toEqual({ isProcessing: false, queueDepth: 0 });
  });

  it('opens the stream with initial_load and processing_status events', async () => {
    await startServer();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/stream`, { headers: { Authorization: `Bearer ${teamKey}` }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('processing_status')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    const events = text.split('\n\n').filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
    expect(events[0].type).toBe('initial_load');
    expect(events[0].projects.sort()).toEqual(['other-project', 'repo-a']);
    expect(events[1]).toEqual({ type: 'processing_status', isProcessing: false, queueDepth: 0 });
  });

  it('leaves no keepalive timer behind when the client disconnects during the opening queries', async () => {
    // Hold the stream's processing-status query until the client has gone,
    // so the disconnect lands while the handler is still awaiting.
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>(resolve => { releaseQuery = resolve; });
    let markGateReached!: () => void;
    const gateReached = new Promise<void>(resolve => { markGateReached = resolve; });
    let markQueryDone!: () => void;
    const queryDone = new Promise<void>(resolve => { markQueryDone = resolve; });
    const gatedPool = new Proxy(pool, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value;
        return (text: unknown, ...rest: unknown[]) => {
          const run = () => (value as (...args: unknown[]) => Promise<unknown>).call(target, text, ...rest);
          if (!String(text).includes('observation_generation_jobs')) return run();
          markGateReached();
          return queryGate.then(run).finally(markQueryDone);
        };
      },
    });
    await startServer({}, gatedPool);

    const intervalSpy = spyOn(globalThis, 'setInterval');
    const clearSpy = spyOn(globalThis, 'clearInterval');
    try {
      const controller = new AbortController();
      const request = fetch(`${baseUrl}/stream`, { headers: { Authorization: `Bearer ${teamKey}` }, signal: controller.signal })
        .catch(() => null);
      await gateReached;
      controller.abort();
      await request;
      releaseQuery();
      // Let the handler run on past the released query before judging it.
      await queryDone;
      await new Promise(resolve => setTimeout(resolve, 100));

      // The close may reach the server after the queries finish; what matters
      // is that no keepalive timer outlives the connection.
      const keepaliveHandles = () => intervalSpy.mock.calls
        .map((call, index) => ({ delay: call[1], handle: intervalSpy.mock.results[index]?.value }))
        .filter(entry => entry.delay === STREAM_KEEPALIVE_MS)
        .map(entry => entry.handle);
      const allCleared = () => keepaliveHandles().every(handle => clearSpy.mock.calls.some(call => call[0] === handle));
      const deadline = Date.now() + 2000;
      while (!allCleared() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(allCleared()).toBe(true);
    } finally {
      for (const handle of intervalSpy.mock.results.map(result => result.value)) clearInterval(handle as never);
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  // The daily log is one file for the whole server, not a per-team resource,
  // so no tenant key may read or wipe it (the worker serves it loopback-only).
  it('serves no log content and never clears the log, even for a write-scoped team key', async () => {
    await startServer();
    expect((await fetch(`${baseUrl}/api/logs/clear`, { method: 'POST' })).status).toBe(401);

    const read = await get('/api/logs', teamKey);
    expect(read.status).toBe(404);
    const readBody = await read.json() as Record<string, unknown>;
    expect(readBody.error).toBe('NotFound');
    expect('logs' in readBody).toBe(false);

    const clear = await fetch(`${baseUrl}/api/logs/clear`, { method: 'POST', headers: { Authorization: `Bearer ${teamKey}` } });
    expect(clear.status).toBe(404);
    expect(((await clear.json()) as Record<string, unknown>).success).toBeUndefined();
  });
});
