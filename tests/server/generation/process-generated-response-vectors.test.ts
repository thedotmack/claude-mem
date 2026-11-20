// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationEmbeddingsRepository } from '../../../src/storage/postgres/observation-embeddings.js';
import { processGeneratedResponse } from '../../../src/server/generation/processGeneratedResponse.js';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, dropSchema, pgvectorAvailable } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const vectorAvailable = await pgvectorAvailable(testDatabaseUrl);

describe.skipIf(!vectorAvailable)('processGeneratedResponse vector writes', () => {
  let pool: pg.Pool;
  let schemaName: string;
  let upsertSpy: ReturnType<typeof spyOn> | null = null;
  let embedSpy: ReturnType<typeof spyOn> | null = null;
  let readySpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(async () => {
    // Vectors without the model, so generation has vectors to write.
    embedSpy = spyOn(LocalEmbedder.prototype, 'embed')
      .mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05)));
    // As if the model had loaded, so the route does not wait for it.
    readySpy = spyOn(LocalEmbedder.prototype, 'isReady').mockReturnValue(true);
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_generation_vectors');
    // public too, where pgvector's type lives.
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    await bootstrapServerPostgresSchema(pool);
  });

  afterEach(async () => {
    upsertSpy?.mockRestore();
    embedSpy?.mockRestore();
    readySpy?.mockRestore();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  it('keeps the generated observations when their vector write fails', async () => {
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
