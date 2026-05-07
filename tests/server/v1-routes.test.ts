import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { createServerApiKey } from '../../src/server/auth/api-key-service.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('server REST API v1 routes', () => {
  let db: Database;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    const options: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null,
      }),
    };
    server = new Server(options);
    server.registerRoutes(new ServerV1Routes({
      getDatabase: () => db,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to bind to an ephemeral TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch (error: any) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') {
        throw error;
      }
    }
    db.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('creates projects, sessions, events, memories, and searchable context', async () => {
    const projectResponse = await post('/v1/projects', {
      name: 'Claude Mem',
      rootPath: '/tmp/claude-mem',
    });
    expect(projectResponse.status).toBe(201);
    const { project } = await projectResponse.json();

    const sessionResponse = await post('/v1/sessions/start', {
      projectId: project.id,
      memorySessionId: 'memory-1',
    });
    expect(sessionResponse.status).toBe(201);
    const { session } = await sessionResponse.json();

    const eventResponse = await post('/v1/events', {
      projectId: project.id,
      serverSessionId: session.id,
      sourceType: 'api',
      eventType: 'observation.created',
      payload: { type: 'learned' },
      occurredAtEpoch: Date.now(),
    });
    expect(eventResponse.status).toBe(201);

    const memoryResponse = await post('/v1/memories', {
      projectId: project.id,
      serverSessionId: session.id,
      kind: 'manual',
      type: 'note',
      title: 'Queue backend',
      narrative: 'BullMQ keeps deployable server queues in Valkey.',
      facts: ['BullMQ mode requires Redis or Valkey'],
    });
    expect(memoryResponse.status).toBe(201);
    const { memory } = await memoryResponse.json();

    const searchResponse = await post('/v1/search', {
      projectId: project.id,
      query: 'BullMQ',
    });
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json();
    expect(search.memories.map((item: any) => item.id)).toContain(memory.id);

    const stemmedSearchResponse = await post('/v1/search', {
      projectId: project.id,
      query: 'queue',
    });
    expect(stemmedSearchResponse.status).toBe(200);
    const stemmedSearch = await stemmedSearchResponse.json();
    expect(stemmedSearch.memories.map((item: any) => item.id)).toContain(memory.id);

    const contextResponse = await post('/v1/context', {
      projectId: project.id,
      query: 'Valkey',
    });
    expect(contextResponse.status).toBe(200);
    const context = await contextResponse.json();
    expect(context.context).toContain('Valkey');

    const endResponse = await post(`/v1/sessions/${session.id}/end`, {});
    expect(endResponse.status).toBe(200);
    expect((await endResponse.json()).session.status).toBe('completed');
  });

  it('denies writes when an API key lacks write scope', async () => {
    const key = createServerApiKey(db, {
      name: 'read only',
      scopes: ['memories:read'],
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.rawKey}`,
      },
      body: JSON.stringify({ name: 'Denied' }),
    });

    expect(response.status).toBe(403);
  });

  it('denies project creation when an API key is scoped to an existing project', async () => {
    const projectResponse = await post('/v1/projects', { name: 'Owner Project' });
    expect(projectResponse.status).toBe(201);
    const { project } = await projectResponse.json();
    const key = createServerApiKey(db, {
      name: 'project scoped writer',
      projectId: project.id,
      scopes: ['memories:write'],
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.rawKey}`,
      },
      body: JSON.stringify({ name: 'Forbidden Project' }),
    });

    expect(response.status).toBe(403);
    const row = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('limits project listing to the API key project scope', async () => {
    const projectAResponse = await post('/v1/projects', { name: 'Scoped Project A' });
    const projectBResponse = await post('/v1/projects', { name: 'Scoped Project B' });
    expect(projectAResponse.status).toBe(201);
    expect(projectBResponse.status).toBe(201);
    const { project: projectA } = await projectAResponse.json();
    await projectBResponse.json();
    const key = createServerApiKey(db, {
      name: 'project A reader',
      projectId: projectA.id,
      scopes: ['memories:read'],
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      headers: {
        Authorization: `Bearer ${key.rawKey}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects.map((project: any) => project.id)).toEqual([projectA.id]);
  });

  it('rejects mixed-project event batches without partial writes', async () => {
    const projectAResponse = await post('/v1/projects', { name: 'Project A' });
    const projectBResponse = await post('/v1/projects', { name: 'Project B' });
    expect(projectAResponse.status).toBe(201);
    expect(projectBResponse.status).toBe(201);
    const { project: projectA } = await projectAResponse.json();
    const { project: projectB } = await projectBResponse.json();
    const key = createServerApiKey(db, {
      name: 'project A writer',
      projectId: projectA.id,
      scopes: ['memories:write'],
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/events/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.rawKey}`,
      },
      body: JSON.stringify([
        {
          projectId: projectA.id,
          sourceType: 'api',
          eventType: 'observation.created',
          payload: { index: 1 },
          occurredAtEpoch: Date.now(),
        },
        {
          projectId: projectB.id,
          sourceType: 'api',
          eventType: 'observation.created',
          payload: { index: 2 },
          occurredAtEpoch: Date.now(),
        },
      ]),
    });

    expect(response.status).toBe(403);
    const row = db.prepare('SELECT COUNT(*) AS count FROM agent_events').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('rejects memory updates that move records across projects', async () => {
    const projectAResponse = await post('/v1/projects', { name: 'Memory Project A' });
    const projectBResponse = await post('/v1/projects', { name: 'Memory Project B' });
    expect(projectAResponse.status).toBe(201);
    expect(projectBResponse.status).toBe(201);
    const { project: projectA } = await projectAResponse.json();
    const { project: projectB } = await projectBResponse.json();
    const memoryResponse = await post('/v1/memories', {
      projectId: projectA.id,
      kind: 'manual',
      type: 'note',
      title: 'Pinned project',
    });
    expect(memoryResponse.status).toBe(201);
    const { memory } = await memoryResponse.json();

    const response = await fetch(`http://127.0.0.1:${port}/v1/memories/${memory.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: projectB.id,
        kind: 'manual',
        type: 'note',
      }),
    });

    expect(response.status).toBe(400);
    const stored = db.prepare('SELECT project_id FROM memory_items WHERE id = ?').get(memory.id) as { project_id: string };
    expect(stored.project_id).toBe(projectA.id);
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
});
