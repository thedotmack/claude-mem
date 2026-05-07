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
    }));
    server.finalizeRoutes();
    port = 41000 + Math.floor(Math.random() * 10000);
    await server.listen(port, '127.0.0.1');
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
