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
  processSessionSummaryResponse,
  type ProcessGeneratedResponseInput,
} from '../../../src/server/generation/processGeneratedResponse.js';
import type { PostgresObservationGenerationJob } from '../../../src/storage/postgres/generation-jobs.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('processGeneratedResponse', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }

  let pool: pg.Pool & ProcessGeneratedResponseInput['pool'];
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
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase5');
    pool = poolForSchema(testDatabaseUrl!, schemaName) as pg.Pool & ProcessGeneratedResponseInput['pool'];
    client = await pool.connect();
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

  });

  afterEach(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } catch {}
      client.release();
    }
    await pool.end();
  });

  async function reloadJob() {
    return await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
  }

  async function claim(job?: PostgresObservationGenerationJob) {
    const id = job?.id ?? jobId;
    await storage.observationGenerationJobs.transitionStatus({ id, projectId, teamId, status: 'processing' });
    return (await storage.observationGenerationJobs.getByIdForScope({ id, projectId, teamId }))!;
  }

  async function summaryJob() {
    const session = await storage.sessions.create({
      projectId, teamId, contentSessionId: `content-${crypto.randomUUID()}`,
      agentId: 'agent-1', platformSource: 'claude-code', metadata: {},
    });
    return storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'session_summary', sourceId: session.id,
      serverSessionId: session.id, jobType: 'observation_generate_session_summary',
    });
  }

  // Regression: the summary path used to read only parsed.summary. A provider that
  // answered with <observation> blocks (which is what the shared prompt asked for)
  // produced summary=null, was judged empty, and the job completed having discarded
  // a paid-for response. Measured on a production deployment: 4,898 summary jobs,
  // zero observations persisted.
  it('persists a summary job answered with <observation> blocks instead of dropping it', async () => {
    const fresh = await claim(await summaryJob());

    const outcome = await processSessionSummaryResponse({
      pool,
      job: fresh,
      rawText: `
        <observation>
          <type>discovery</type>
          <title>Session arc</title>
          <facts><fact>the run ended with the queue drained</fact></facts>
        </observation>
      `,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      // the point of the fix: the response is kept, not silently discarded
      expect(outcome.observations.length).toBeGreaterThan(0);
      expect(outcome.observations[0]!.content).toContain('queue drained');
    }

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: fresh.id,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('completed');
  });

  // The parser's empty-observation guard accepts a block whose only populated
  // field is <concepts>, but renderObservationContent ignored concepts, so the
  // block rendered to '' and was skipped as empty content - the same
  // accepted-then-discarded shape this PR is about, one layer down.
  it('persists a concepts-only response instead of completing the job empty', async () => {
    const fresh = await claim(await summaryJob());

    const outcome = await processSessionSummaryResponse({
      pool,
      job: fresh,
      rawText: `
        <observation>
          <type>discovery</type>
          <concepts><concept>outbox drain</concept><concept>valkey backpressure</concept></concepts>
        </observation>
      `,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.content).toContain('outbox drain');
      expect(outcome.observations[0]!.content).toContain('valkey backpressure');
      expect(outcome.privateContentDetected).toBe(false);
    }
  });

  // Same defect on the per-event path: concepts-only blocks were skipped by the
  // empty-content guard and the job still completed.
  it('persists a concepts-only observation on the per-event path', async () => {
    const fresh = await claim();

    const outcome = await processGeneratedResponse({
      pool,
      job: fresh,
      rawText: `
        <observation>
          <type>discovery</type>
          <concepts><concept>lease renewal</concept></concepts>
        </observation>
      `,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.content).toContain('lease renewal');
    }
  });

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
    const fresh = await claim();
    const outcome = await processGeneratedResponse({
      pool,
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

  it('persists freeform prose from a closed observation block', async () => {
    const xml = `
      <observation>
        This deploy unblocked the worker restart path after the queue drained.
      </observation>
    `;

    const fresh = await claim();
    const outcome = await processGeneratedResponse({
      pool,
      job: fresh,
      rawText: xml,
      providerLabel: 'fake',
      modelId: 'fake-1',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.content).toContain('This deploy unblocked the worker restart path');
      expect(outcome.observations[0]!.metadata.title).toBe('This deploy unblocked the worker restart path after the queue drained.');
      expect(outcome.observations[0]!.content).not.toContain('This deploy unblocked the worker restart path after the queue drained.\n\nThis deploy unblocked the worker restart path after the queue drained.');
    }
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
      const fresh = await claim();
      const outcome = await processGeneratedResponse({
        pool,
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
      const fresh = await claim();
      await processGeneratedResponse({
        pool,
        job: fresh, rawText: xml, providerLabel: 'fake', modelId: 'fake-1', tokensUsed: 999,
      });
      const n = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE team_id = $1`, [teamId]);
      expect(n.rows[0]?.n).toBe(0);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_MEM_USAGE_METERING = prev;
    }
  });

  it('marks job completed with no observation when the response is a skip_summary', async () => {
    const fresh = await claim();
    const outcome = await processGeneratedResponse({
      pool,
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

  it('copies the session folder label onto generated observation metadata', async () => {
    const session = await storage.sessions.create({
      projectId,
      teamId,
      externalSessionId: 'ext-session-folder',
      metadata: { project: 'my-folder' },
    });
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { tool: 'bash', input: 'pwd' },
      occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_for_event',
    });
    const fresh = await claim(job);

    const outcome = await processGeneratedResponse({
      pool,
      job: fresh,
      rawText: `
        <observation>
          <type>discovery</type>
          <title>Folder travels</title>
          <facts><fact>session metadata carries the folder</fact></facts>
        </observation>
      `,
      providerLabel: 'fake',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations).toHaveLength(1);
      expect(outcome.observations[0]!.metadata.project).toBe('my-folder');
    }
  });

  it('writes project: null when the job carries no server session (legacy jobs)', async () => {
    const fresh = await claim();
    const outcome = await processGeneratedResponse({
      pool,
      job: fresh,
      rawText: `
        <observation>
          <type>discovery</type>
          <title>No session</title>
          <facts><fact>legacy job without a session row</fact></facts>
        </observation>
      `,
      providerLabel: 'fake',
    });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.observations[0]!.metadata.project).toBeNull();
    }
  });

});
