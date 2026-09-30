// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/context with `query` omitted returns the project's most recent
// observations: the read a session-start block needs (plan-24 step 4). The
// platform and folder filters must apply in that mode exactly as they do to a
// relevance read. Postgres-gated; isolation via tests/sdk/pg-isolation.ts.

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
  let apiKey: string;
  let teamId: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  // Creates one observation and pins its created_at `minutesAgo` minutes in the
  // past, so the expected recency order never depends on insert timing.
  async function observation(input: {
    content: string;
    minutesAgo: number;
    serverSessionId?: string;
    folderProject?: string;
  }): Promise<string> {
    const created = await storage.observations.create({
      projectId,
      teamId,
      kind: 'discovery',
      content: input.content,
      serverSessionId: input.serverSessionId ?? null,
      metadata: input.folderProject ? { project: input.folderProject } : {},
    });
    await client.query(
      `UPDATE observations SET created_at = now() - ($2::int * interval '1 minute') WHERE id = $1`,
      [created.id, input.minutesAgo],
    );
    return created.id;
  }

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_ctx_recency');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'P' });
    projectId = project.id;

    const claudeSession = await storage.sessions.create({
      projectId, teamId, contentSessionId: 'claude-session', platformSource: 'claude',
    });
    const cursorSession = await storage.sessions.create({
      projectId, teamId, contentSessionId: 'cursor-session', platformSource: 'cursor',
    });

    await observation({ content: 'first observation about setup', minutesAgo: 30, serverSessionId: claudeSession.id, folderProject: 'alpha' });
    await observation({ content: 'second observation about routing', minutesAgo: 20, serverSessionId: claudeSession.id, folderProject: 'beta' });
    await observation({ content: 'third observation about deployment', minutesAgo: 10, serverSessionId: claudeSession.id, folderProject: 'alpha' });
    await observation({ content: 'cursor observation about deployment', minutesAgo: 5, serverSessionId: cursorSession.id, folderProject: 'alpha' });
    await observation({ content: 'unlabelled observation without a session', minutesAgo: 1 });

    const key = newApiKey();
    apiKey = key.raw;
    await storage.auth.createApiKey({
      keyHash: key.hash, teamId, projectId: null, actorId: 't', scopes: ['memories:read', 'memories:write'],
    });

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((spy) => spy.mockRestore());
    mock.restore();
  });

  async function context(body: Record<string, unknown>): Promise<{ status: number; contents: string[]; context: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...body }),
    });
    if (response.status !== 200) return { status: response.status, contents: [], context: '' };
    const json = await response.json() as { observations: Array<{ content: string }>; context: string };
    return { status: 200, contents: json.observations.map((o) => o.content), context: json.context };
  }

  it('returns observations newest first, with a joined context string, when query is omitted', async () => {
    const result = await context({});
    expect(result.status).toBe(200);
    expect(result.contents).toEqual([
      'unlabelled observation without a session',
      'cursor observation about deployment',
      'third observation about deployment',
      'second observation about routing',
      'first observation about setup',
    ]);
    expect(result.context).toContain('third observation');
  });

  it('respects `limit` in recency mode', async () => {
    const result = await context({ limit: 2 });
    expect(result.contents).toEqual([
      'unlabelled observation without a session',
      'cursor observation about deployment',
    ]);
  });

  it('applies the platform filter in recency mode', async () => {
    const result = await context({ platformSource: 'claude' });
    expect(result.contents).toEqual([
      'third observation about deployment',
      'second observation about routing',
      'first observation about setup',
    ]);
  });

  it('applies the folder filter, excluding rows without a folder label', async () => {
    const result = await context({ folderProjects: ['alpha'] });
    expect(result.contents).toEqual([
      'cursor observation about deployment',
      'third observation about deployment',
      'first observation about setup',
    ]);
  });

  it('combines the platform and folder filters', async () => {
    const result = await context({ platformSource: 'claude', folderProjects: ['alpha', 'beta'] });
    expect(result.contents).toEqual([
      'third observation about deployment',
      'second observation about routing',
      'first observation about setup',
    ]);
  });

  it('still runs a relevance-ranked full-text search when a query is given', async () => {
    expect((await context({ query: 'routing' })).contents).toEqual(['second observation about routing']);
    expect((await context({ query: 'deployment', platformSource: 'cursor' })).contents)
      .toEqual(['cursor observation about deployment']);
  });

  it('orders by creation time, so updating an old observation does not move it to the top', async () => {
    await client.query(
      `UPDATE observations SET updated_at = now() + interval '1 day' WHERE content = 'first observation about setup'`,
    );
    const result = await context({});
    expect(result.contents[0]).toBe('unlabelled observation without a session');
    expect(result.contents.at(-1)).toBe('first observation about setup');
  });

  it('defaults to 50 rows without a query and 10 with one', async () => {
    for (let index = 0; index < 12; index++) {
      await observation({ content: `bulk note number ${index}`, minutesAgo: 60 + index });
    }
    expect((await context({})).contents).toHaveLength(17);
    expect((await context({ query: 'bulk note' })).contents).toHaveLength(10);
  });

  it('caps limit at 200 and rejects an empty query string', async () => {
    expect((await context({ limit: 200 })).status).toBe(200);
    expect((await context({ limit: 201 })).status).toBe(400);
    // The key is omitted for recency; an empty string is a malformed query.
    expect((await context({ query: '' })).status).toBe(400);
  });

  it('leaves /v1/search requiring a query', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(response.status).toBe(400);
  });
});
