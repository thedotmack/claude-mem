// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationEmbeddingsRepository } from '../../../src/storage/postgres/observation-embeddings.js';
import { processGeneratedResponse } from '../../../src/server/generation/processGeneratedResponse.js';
import { getSharedEmbedder } from '../../../src/server/services/ObservationEmbeddingService.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, dropSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('processGeneratedResponse vector writes', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  let pool: pg.Pool;
  let schemaName: string;
  let upsertSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(async () => {
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_generation_vectors');
    // public too, where pgvector's type lives.
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    await bootstrapServerPostgresSchema(pool);
  });

  afterEach(async () => {
    upsertSpy?.mockRestore();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  it('keeps the generated observations when their vector write fails', async () => {
    // Needs pgvector and the embedding model, so generation has vectors to write.
    const vectors = (await pool.query(`SELECT to_regclass('observation_embeddings') IS NOT NULL AS present`)).rows[0].present;
    const model = await getSharedEmbedder().embed(['probe']).then(() => true, () => false);
    if (!vectors || !model) return console.warn('pgvector or the embedding model is unavailable; vector write not tested');

    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'project' });
    const event = await storage.agentEvents.create({
      projectId: project.id, teamId: team.id, sourceAdapter: 'api', eventType: 'tool_use',
      payload: { tool: 'bash', input: 'ls' }, occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId: project.id, teamId: team.id, sourceType: 'agent_event', sourceId: event.id,
      agentEventId: event.id, jobType: 'observation_generate_for_event',
    });
    await storage.observationGenerationJobs.transitionStatus({ id: job.id, projectId: project.id, teamId: team.id, status: 'processing' });
    const fresh = (await storage.observationGenerationJobs.getByIdForScope({ id: job.id, projectId: project.id, teamId: team.id }))!;

    // A real failed statement inside the transaction, which aborts it the way
    // a timed-out insert would.
    upsertSpy = spyOn(PostgresObservationEmbeddingsRepository.prototype, 'upsert').mockImplementation(async function (this: unknown) {
      await (this as { client: pg.PoolClient }).client.query('SELECT 1 / 0');
    });
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: '<observation><type>discovery</type><title>Tool ran</title><facts><fact>command was ls</fact></facts></observation>',
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('completed');
    const saved = await pool.query('SELECT count(*)::int AS count FROM observations WHERE project_id = $1', [project.id]);
    expect(saved.rows[0].count).toBe(1);
  });
});
