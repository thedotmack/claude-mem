// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

class StubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;

  constructor(private readonly response: string | Error) {}

  async generate() {
    this.calls += 1;
    if (this.response instanceof Error) throw this.response;
    return { rawText: this.response, providerLabel: this.providerLabel };
  }
}

describe('ProviderObservationGenerator', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_phase5_gen_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(),
    });
    eventId = event.id;
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } catch {}
      client.release();
    }
    pool.removeAllListeners('connect');
  });

  function makeJob(): Job<GenerateObservationsForEventJob> {
    return {
      id: 'bull-1',
      data: {
        kind: 'event',
        team_id: teamId,
        project_id: projectId,
        source_type: 'agent_event',
        source_id: eventId,
        generation_job_id: jobId,
        agent_event_id: eventId,
        api_key_id: null,
        actor_id: null,
        source_adapter: 'api',
      },
    } as unknown as Job<GenerateObservationsForEventJob>;
  }

  it('completes a job using the fake provider response', async () => {
    const xml = '<observation><type>discovery</type><title>OK</title><facts><fact>f</fact></facts></observation>';
    const provider = new StubProvider(xml);
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as Parameters<typeof ProviderObservationGenerator['prototype']['process']>[0]['data'] extends never
        ? never
        : never,
      provider,
    } as unknown as { pool: pg.Pool; provider: ServerGenerationProvider });

    const result = await generator.process(makeJob());
    expect(result.status).toBe('completed');
    expect(result.observationCount).toBe(1);
    expect(provider.calls).toBe(1);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('completed');
  });

  it('marks a job as failed (no retry) when provider returns malformed XML', async () => {
    const provider = new StubProvider('not xml at all');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');
  });
});
