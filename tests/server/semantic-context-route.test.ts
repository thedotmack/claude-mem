// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/context/semantic, the server's per-prompt injection read, takes the
// same limit and prompt-length rules as the worker's /api/context/semantic:
// a limit over SEMANTIC_CONTEXT_MAX_LIMIT is clamped, not rejected, and a
// prompt under SEMANTIC_CONTEXT_MIN_QUERY_CHARS gets an empty answer.
// Postgres-gated; isolation via tests/sdk/pg-isolation.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { SEMANTIC_CONTEXT_MAX_LIMIT } from '../../src/shared/semantic-context.js';
import { embedObservationRows, getSharedEmbedder } from '../../src/server/services/ObservationEmbeddingService.js';
import { PostgresObservationEmbeddingsRepository } from '../../src/storage/postgres/observation-embeddings.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('POST /v1/context/semantic limits', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let server: Server;
  let port: number;
  let apiKey: string;
  let projectId: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => {}),
    );
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_semantic_ctx');
    // public too, where pgvector's type lives once any test has created it.
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    client = await pool.connect();
    // Through the pool, as the server does: whether vectors are available is
    // recorded for the pool the route reads through.
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    projectId = (await storage.projects.create({ teamId: team.id, name: 'P' })).id;
    const key = newApiKey();
    apiKey = key.raw;
    await storage.auth.createApiKey({
      keyHash: key.hash, teamId: team.id, projectId: null, actorId: 't', scopes: ['memories:read'],
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

  async function semantic(body: Record<string, unknown>): Promise<{ status: number; count?: number; context?: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/context/semantic`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ...body }),
    });
    if (response.status !== 200) return { status: response.status };
    const json = await response.json() as { count: number; context: string };
    return { status: 200, count: json.count, context: json.context };
  }

  // An answer with content needs pgvector and the embedding model; without
  // either the route answers empty and these tests say so and return.
  async function canAnswer(): Promise<boolean> {
    // Whether this database got the embeddings table, which the bootstrap
    // creates only where pgvector 0.8+ is usable, not merely installable.
    const table = await pool.query<{ present: boolean }>(`SELECT to_regclass('observation_embeddings') IS NOT NULL AS present`);
    const vectors = table.rows[0]?.present === true;
    const model = await getSharedEmbedder().embed(['probe']).then(() => true, () => false);
    // The search CI job (CLAUDE_MEM_TEST_PGVECTOR=1) has both; there a
    // missing one fails these tests instead of passing them untested.
    if (process.env.CLAUDE_MEM_TEST_PGVECTOR === '1') {
      expect({ vectors, model }).toEqual({ vectors: true, model: true });
    }
    if (!vectors || !model) console.warn('vector search or the embedding model is unavailable; semantic answers not tested');
    return vectors && model;
  }

  async function seed(rows: Array<{ content: string; kind?: string; metadata?: Record<string, string> }>): Promise<void> {
    const storage = createPostgresStorageRepositories(client);
    const team = (await client.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [projectId])).rows[0]!.team_id;
    const embeddings = new PostgresObservationEmbeddingsRepository(pool);
    for (const row of rows) {
      const observation = await storage.observations.create({ projectId, teamId: team, ...row });
      // With vectors, so the search finds them by meaning on any Postgres
      // with pgvector, not only where bm25 matches any keyword.
      const [embedded] = (await embedObservationRows(pool, [observation])) ?? [];
      if (embedded) await embeddings.upsert({ observationId: observation.id, model: getSharedEmbedder().modelId, ...embedded });
    }
  }

  it('clamps a limit above the cap instead of rejecting it, as the worker does', async () => {
    const query = 'when did we change the retry limit for the queue';
    const result = await semantic({ query, limit: SEMANTIC_CONTEXT_MAX_LIMIT + 10 });
    expect(result.status).toBe(200);
    if (!(await canAnswer())) return;
    await seed(Array.from({ length: SEMANTIC_CONTEXT_MAX_LIMIT + 10 }, (_, i) => ({
      content: `Raised the queue retry limit to ${i + 2}.`,
      metadata: { title: `Retry limit ${i}`, narrative: `Raised the queue retry limit to ${i + 2}.` },
    })));
    const capped = await semantic({ query, limit: SEMANTIC_CONTEXT_MAX_LIMIT + 10 });
    expect(capped.count).toBe(SEMANTIC_CONTEXT_MAX_LIMIT);
    expect(capped.context?.match(/^### /gm)?.length).toBe(SEMANTIC_CONTEXT_MAX_LIMIT);
  });

  it('renders the content of a memory or summary that has no narrative', async () => {
    if (!(await canAnswer())) return;
    await seed([
      { content: 'The queue retry limit is now five, set in the gateway config.' },
      { kind: 'summary', content: 'Session summary: raised the queue retry limit and redeployed.' },
    ]);
    const result = await semantic({ query: 'when did we change the retry limit for the queue' });
    expect(result.context).toContain('The queue retry limit is now five, set in the gateway config.');
    expect(result.context).toContain('### Session summary (');
    expect(result.context).toContain('raised the queue retry limit and redeployed.');
  });

  it('answers a short prompt with no context', async () => {
    expect(await semantic({ query: 'yes go on' })).toEqual({ status: 200, count: 0, context: '' });
  });
});
