// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationEmbeddingsRepository } from '../../../src/storage/postgres/observation-embeddings.js';
import { getSharedEmbedder } from '../../../src/server/services/ObservationEmbeddingService.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { createIsolatedSchema, dropSchema, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
describe('POST /v1/memories vector write', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  let pool: pg.Pool;
  let schema: string;
  let server: Server;
  let url: string;
  let projectId: string;
  let apiKey: string;
  let upsertSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl, 'cm_memory_vectors');
    // public too, where pgvector's type lives.
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    projectId = (await storage.projects.create({ teamId: team.id, name: 'project' })).id;
    const { raw, hash } = newApiKey();
    apiKey = raw;
    await storage.auth.createApiKey({ keyHash: hash, teamId: team.id, projectId,
      actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    server = new Server({ getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {}, workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }) });
    server.registerRoutes(new ServerV1PostgresRoutes({ pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'), authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}/v1/memories`;
  });
  afterEach(async () => {
    upsertSpy?.mockRestore();
    try { await server?.close(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await pool?.end();
    if (schema) await dropSchema(databaseUrl, schema);
  });

  it('answers 201 for a saved memory whose vector write fails', async () => {
    // Needs pgvector and the embedding model, so the route has vectors to write.
    const vectors = (await pool.query(`SELECT to_regclass('observation_embeddings') IS NOT NULL AS present`)).rows[0].present;
    const model = await getSharedEmbedder().embed(['probe']).then(() => true, () => false);
    if (!vectors || !model) return console.warn('pgvector or the embedding model is unavailable; vector write not tested');

    upsertSpy = spyOn(PostgresObservationEmbeddingsRepository.prototype, 'upsert')
      .mockRejectedValue(new Error('connection lost'));
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, content: 'The retry limit is five.' }) });
    expect(response.status).toBe(201);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const saved = await pool.query('SELECT count(*)::int AS count FROM observations WHERE project_id = $1', [projectId]);
    expect(saved.rows[0].count).toBe(1);
  });
});
