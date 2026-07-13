// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/context with `query` omitted: recency-ordered "recent context"
// mode, added for SessionStart server-runtime support (plans/2026-07-13-
// session-start-context-injection-server-mode.md, closes #2991). Postgres-
// gated, mirrors the isolation pattern in data-deletion.test.ts /
// pg-isolation.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, poolForSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('POST /v1/context recency mode (no query)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let readKey: string;
  let teamId: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_ctx_recency');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'P' });
    projectId = project.id;

    // Sequential awaited creates so `updated_at` strictly increases —
    // recency order should come back newest-first.
    await storage.observations.create({ projectId, teamId, kind: 'manual', content: 'first observation about setup' });
    await storage.observations.create({ projectId, teamId, kind: 'manual', content: 'second observation about routing' });
    await storage.observations.create({ projectId, teamId, kind: 'manual', content: 'third observation about deployment' });

    const k = newApiKey(); readKey = k.raw;
    await storage.auth.createApiKey({ keyHash: k.hash, teamId, projectId: null, actorId: 't', scopes: ['memories:read', 'memories:write'] });

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const addr = server.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const auth = () => ({ Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' });
  const post = (p: string, body: unknown) =>
    fetch(url(p), { method: 'POST', headers: auth(), body: JSON.stringify(body) });

  it('returns recency-ordered observations and a joined context string when query is omitted', async () => {
    const r = await post('/v1/context', { projectId });
    expect(r.status).toBe(200);
    const body = await r.json() as { observations: Array<{ content: string }>; context: string };
    expect(body.observations).toHaveLength(3);
    // Newest first.
    expect(body.observations[0].content).toContain('third observation');
    expect(body.observations[2].content).toContain('first observation');
    expect(body.context).toContain('third observation');
    expect(body.context).toContain('first observation');
  });

  it('respects `limit` in recency mode', async () => {
    const r = await post('/v1/context', { projectId, limit: 2 });
    expect(r.status).toBe(200);
    const body = await r.json() as { observations: Array<{ content: string }> };
    expect(body.observations).toHaveLength(2);
    expect(body.observations[0].content).toContain('third observation');
    expect(body.observations[1].content).toContain('second observation');
  });

  it('still does relevance-ranked search when query is provided (no regression)', async () => {
    const r = await post('/v1/context', { projectId, query: 'routing' });
    expect(r.status).toBe(200);
    const body = await r.json() as { observations: Array<{ content: string }> };
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].content).toContain('second observation');
  });

  it('treats an empty-string query the same as omitted (recency mode, not a 0-result FTS match)', async () => {
    const r = await post('/v1/context', { projectId, query: '' });
    expect(r.status).toBe(200);
    const body = await r.json() as { observations: Array<{ content: string }> };
    expect(body.observations).toHaveLength(3);
    expect(body.observations[0].content).toContain('third observation');
  });

  it('/v1/search still requires a non-empty query (no change to that route)', async () => {
    const r = await post('/v1/search', { projectId });
    expect(r.status).toBe(400);
  });
});
