// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import {
  processGeneratedResponse,
  markGenerationFailed,
} from '../../../src/server/generation/processGeneratedResponse.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

describe('processGeneratedResponse + markGenerationFailed', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
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
    // The generation path reads the active ModeManager mode; load it so this
    // file runs standalone instead of relying on another test file's side effect.
    ModeManager.getInstance().loadMode('code');
    client = await pool.connect();
    schemaName = `cm_phase5_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'proj-a' });
    teamId = team.id;
    projectId = project.id;

    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { tool: 'bash', input: 'ls' },
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

    // Re-bind the storage layer to the pool so processGeneratedResponse's
    // internal transactions see the test schema. We do this by setting
    // search_path for new pool connections via on-connect hook, but pg's
    // Pool does not expose that easily. Workaround: use the pool from the
    // search_path-aware helper below. For these tests we monkey-patch the
    // shared pool to set search_path on new connections.
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
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

  async function reloadJob() {
    return await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
  }

  it('persists observation, links source, and marks job completed for valid XML', async () => {
    const xml = `
      <observation>
        <type>discovery</type>
        <title>Tool ran</title>
        <facts><fact>command was ls</fact></facts>
      </observation>
    `;
    const job = await reloadJob();
    expect(job).toBeTruthy();

    // Lock first, like the real generator does.
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });

    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.generationKey).toMatch(/^generation:v1:/);
    }

    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('completed');

    // observation_sources row exists
    const sources = await storage.observationSources.listByObservationForScope({
      observationId: outcome.kind === 'completed' ? outcome.observations[0]!.id : '',
      projectId,
      teamId,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceType).toBe('agent_event');
    expect(sources[0]!.sourceId).toBe(eventId);
    expect(sources[0]!.generationJobId).toBe(jobId);
  });

  it('records token + observation usage when metering is enabled', async () => {
    const prev = process.env.CLAUDE_MEM_USAGE_METERING;
    process.env.CLAUDE_MEM_USAGE_METERING = '1';
    try {
      const xml = `
        <observation>
          <type>discovery</type>
          <title>Metered</title>
          <facts><fact>token metering</fact></facts>
        </observation>
      `;
      await storage.observationGenerationJobs.transitionStatus({ id: jobId, projectId, teamId, status: 'processing' });
      const fresh = (await reloadJob())!;
      const outcome = await processGeneratedResponse({
        pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
        job: fresh,
        rawText: xml,
        providerLabel: 'fake',
        modelId: 'fake-1',
        tokensUsed: 1234,
      });
      expect(outcome.kind).toBe('completed');

      const usage = await pool.query(
        `SELECT kind, SUM(quantity)::bigint AS total FROM usage_events WHERE team_id = $1 GROUP BY kind`,
        [teamId],
      );
      const byKind: Record<string, number> = {};
      for (const r of usage.rows) byKind[r.kind] = Number(r.total);
      expect(byKind.tokens).toBe(1234);
      expect(byKind.observation).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_USAGE_METERING;
      else process.env.CLAUDE_MEM_USAGE_METERING = prev;
    }
  });

  it('does NOT record usage when metering is disabled', async () => {
    const prev = process.env.CLAUDE_MEM_USAGE_METERING;
    delete process.env.CLAUDE_MEM_USAGE_METERING;
    try {
      const xml = `<observation><type>discovery</type><title>x</title><facts><fact>f</fact></facts></observation>`;
      await storage.observationGenerationJobs.transitionStatus({ id: jobId, projectId, teamId, status: 'processing' });
      const fresh = (await reloadJob())!;
      await processGeneratedResponse({
        pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
        job: fresh, rawText: xml, providerLabel: 'fake', modelId: 'fake-1', tokensUsed: 999,
      });
      const n = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE team_id = $1`, [teamId]);
      expect(n.rows[0]?.n).toBe(0);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_MEM_USAGE_METERING = prev;
    }
  });

  it('replaying the same job yields exactly one observation (idempotency)', async () => {
    const xml = `<observation><type>discovery</type><title>Same</title><facts><fact>same</fact></facts></observation>`;

    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });

    const fresh = (await reloadJob())!;
    const first = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
    });
    expect(first.kind).toBe('completed');

    // Manually move job back to processing to simulate retry
    // (in practice retry would create a new job invocation, but the
    // idempotency guard is at the observation level via generation_key).
    // The terminal-status check inside processGeneratedResponse will
    // short-circuit the second call cleanly, demonstrating that retries
    // do not re-write observations.
    const second = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
    });
    expect(second.kind).toBe('completed');

    // Verify only one observation exists
    const list = await storage.observations.listByProject({ projectId, teamId });
    expect(list).toHaveLength(1);
  });

  it('marks job completed with no observation when the response is a skip_summary', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: '<skip_summary reason="all_events_private" />',
      providerLabel: 'fake',
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(0);
      expect(outcome.privateContentDetected).toBe(true);
    }

    const list = await storage.observations.listByProject({ projectId, teamId });
    expect(list).toHaveLength(0);

    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('completed');
  });

  it('returns parse_error and does not write observations for malformed XML', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    const outcome = await processGeneratedResponse({
      pool: pool as unknown as Parameters<typeof processGeneratedResponse>[0]['pool'],
      job: fresh,
      rawText: 'this is just prose without any xml',
      providerLabel: 'fake',
    });
    expect(outcome.kind).toBe('parse_error');

    const list = await storage.observations.listByProject({ projectId, teamId });
    expect(list).toHaveLength(0);

    // Job still in processing — caller (ProviderObservationGenerator) is
    // responsible for transitioning to failed/retry.
    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('processing');
  });

  it('markGenerationFailed routes to retry when retryable and attempts left', async () => {
    await storage.observationGenerationJobs.transitionStatus({
      id: jobId,
      projectId,
      teamId,
      status: 'processing',
    });
    const fresh = (await reloadJob())!;
    await markGenerationFailed({
      pool: pool as unknown as Parameters<typeof markGenerationFailed>[0]['pool'],
      job: fresh,
      reason: 'transient',
      classification: 'transient',
      retryable: true,
    });
    const reloaded = await reloadJob();
    expect(reloaded?.status).toBe('queued');
  });
});
