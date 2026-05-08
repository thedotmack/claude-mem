// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import {
  ProviderObservationGenerator,
  ServerGenerationScopeViolationError,
} from '../../../src/server/generation/ProviderObservationGenerator.js';
import { ServerGenerationJobPayloadValidationError } from '../../../src/server/jobs/types.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { ServerGenerationJobPayload, GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';

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

describe('Phase 11 — ProviderObservationGenerator scope enforcement', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let foreignTeamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;
  let apiKeyId: string;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_phase11_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });

    const team = await storage.teams.create({ name: 'team-a' });
    const foreignTeam = await storage.teams.create({ name: 'team-b' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    foreignTeamId = foreignTeam.id;
    projectId = project.id;

    const apiKey = await storage.auth.createApiKey({
      keyHash: 'h_' + crypto.randomUUID().replaceAll('-', ''),
      teamId,
      projectId,
      actorId: 'system:phase11-test',
      scopes: ['memories:write'],
    });
    apiKeyId = apiKey.id;

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

  function makeJob(overrides: Partial<GenerateObservationsForEventJob> = {}): Job<ServerGenerationJobPayload> {
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
        api_key_id: apiKeyId,
        actor_id: 'system:phase11-test',
        source_adapter: 'api',
        ...overrides,
      },
    } as unknown as Job<ServerGenerationJobPayload>;
  }

  it('rejects payload when reloaded outbox team_id differs from job payload team_id', async () => {
    const provider = new StubProvider('<observation><type>x</type><title>OK</title></observation>');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    // Tampered payload — claims a different team.
    const job = makeJob({ team_id: foreignTeamId });

    await expect(generator.process(job)).rejects.toBeInstanceOf(ServerGenerationScopeViolationError);
    expect(provider.calls).toBe(0);

    // Job should be in 'failed' status with classification 'scope_mismatch'.
    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');

    // Audit row should have been written under generation_job.scope_violation.
    const auditRows = await pool.query<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_log WHERE resource_id = $1 AND action = $2`,
      [jobId, 'generation_job.scope_violation'],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects payload when api key was revoked between enqueue and execute', async () => {
    // Revoke the api key.
    await pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1`,
      [apiKeyId],
    );

    const provider = new StubProvider('<observation><type>x</type><title>OK</title></observation>');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    await expect(generator.process(makeJob())).rejects.toBeInstanceOf(ServerGenerationScopeViolationError);
    expect(provider.calls).toBe(0);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource_id = $1 AND action = $2`,
      [jobId, 'generation_job.revoked_key'],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed payload at execution boundary', async () => {
    const provider = new StubProvider('<observation><type>x</type><title>OK</title></observation>');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    // Strip required fields — this should be caught BEFORE any DB lookup.
    const job = {
      id: 'bull-bad',
      data: { kind: 'event', team_id: teamId },
    } as unknown as Job<ServerGenerationJobPayload>;

    await expect(generator.process(job)).rejects.toBeInstanceOf(
      ServerGenerationJobPayloadValidationError,
    );
    expect(provider.calls).toBe(0);
  });

  it('writes the full audit chain on a successful generation', async () => {
    const provider = new StubProvider(
      '<observation><type>discovery</type><title>OK</title><facts><fact>f</fact></facts></observation>',
    );
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    const result = await generator.process(makeJob());
    expect(result.status).toBe('completed');
    expect(result.observationCount).toBe(1);

    // Phase 11 — every observation row should carry team/project from the
    // canonical outbox/source row, not from the BullMQ payload.
    const obsRows = await pool.query<{ team_id: string; project_id: string }>(
      `SELECT team_id, project_id FROM observations WHERE created_by_job_id = $1`,
      [jobId],
    );
    expect(obsRows.rows.length).toBe(1);
    expect(obsRows.rows[0]!.team_id).toBe(teamId);
    expect(obsRows.rows[0]!.project_id).toBe(projectId);

    // Phase 11 — observation_sources.metadata carries the identity context.
    const sourceRows = await pool.query<{ metadata: { source_adapter: string; api_key_id: string | null; actor_id: string | null } }>(
      `SELECT metadata FROM observation_sources WHERE generation_job_id = $1`,
      [jobId],
    );
    expect(sourceRows.rows.length).toBe(1);
    const meta = sourceRows.rows[0]!.metadata;
    expect(meta.source_adapter).toBe('api');
    expect(meta.api_key_id).toBe(apiKeyId);
    expect(meta.actor_id).toBe('system:phase11-test');

    // Phase 11 — full audit chain. Every row must reference generation_job_id
    // in details for traceability.
    const audit = await pool.query<{ action: string; details: { generationJobId?: string } }>(
      `SELECT action, details FROM audit_log
       WHERE (details->>'generationJobId') = $1 OR resource_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    const actions = audit.rows.map(r => r.action);
    expect(actions).toContain('generation_job.processing');
    expect(actions).toContain('observation.created');
    expect(actions).toContain('generation_job.completed');
  });
});
