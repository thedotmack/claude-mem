// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  PostgresServerSessionsRepository,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ServerSessionRuntimeRepository } from '../../../src/server/runtime/ServerSessionRuntimeRepository.js';
import {
  buildEnqueueEventDecision,
  buildSummaryJobId,
  resolveSessionGenerationPolicy,
} from '../../../src/server/runtime/SessionGenerationPolicy.js';
import { processSessionSummaryResponse } from '../../../src/server/generation/processGeneratedResponse.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

describe('SessionGenerationPolicy (pure)', () => {
  it('defaults to per-event when env is unset', () => {
    const oldEnv = process.env.CLAUDE_MEM_SERVER_SESSION_POLICY;
    delete process.env.CLAUDE_MEM_SERVER_SESSION_POLICY;
    try {
      const resolved = resolveSessionGenerationPolicy();
      expect(resolved.policy).toBe('per-event');
    } finally {
      if (oldEnv !== undefined) process.env.CLAUDE_MEM_SERVER_SESSION_POLICY = oldEnv;
    }
  });

  it('honors explicit policy override', () => {
    expect(resolveSessionGenerationPolicy({ policy: 'debounce' }).policy).toBe('debounce');
    expect(resolveSessionGenerationPolicy({ policy: 'end-of-session' }).policy).toBe('end-of-session');
    expect(resolveSessionGenerationPolicy({ policy: 'per-event' }).policy).toBe('per-event');
  });

  it('per-event policy enqueues immediately with no delay', () => {
    const decision = buildEnqueueEventDecision({
      event: makeFakeEvent('e1', 's1'),
      outbox: makeFakeOutbox('j1', 'e1'),
    }, { policy: 'per-event' });
    expect(decision.shouldEnqueue).toBe(true);
    expect(decision.reason).toBe('per-event');
    expect(decision.jobsOptions).toBeUndefined();
  });

  it('debounce policy enqueues with delay', () => {
    const decision = buildEnqueueEventDecision({
      event: makeFakeEvent('e1', 's1'),
      outbox: makeFakeOutbox('j1', 'e1'),
    }, { policy: 'debounce', debounceWindowMs: 1234 });
    expect(decision.shouldEnqueue).toBe(true);
    expect(decision.reason).toBe('debounce');
    expect(decision.jobsOptions?.delay).toBe(1234);
  });

  it('end-of-session policy skips enqueue', () => {
    const decision = buildEnqueueEventDecision({
      event: makeFakeEvent('e1', 's1'),
      outbox: makeFakeOutbox('j1', 'e1'),
    }, { policy: 'end-of-session' });
    expect(decision.shouldEnqueue).toBe(false);
    expect(decision.reason).toBe('end-of-session-skip');
  });

  it('summary job id is deterministic per server_session_id', () => {
    const a = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const b = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const c = buildSummaryJobId({ serverSessionId: 's2', teamId: 't', projectId: 'p' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain(':');
  });
});

describe('ServerSessionRuntimeRepository + Postgres', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let runtime: ServerSessionRuntimeRepository;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_phase6_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    runtime = new ServerSessionRuntimeRepository({ client });

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    if (!client) return;
    try {
      if (schemaName) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('getActiveSession is idempotent on (project_id, external_session_id)', async () => {
    const a = await runtime.getActiveSession({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    const b = await runtime.getActiveSession({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    expect(a.id).toBe(b.id);
    expect(a.externalSessionId).toBe('ext-1');
  });

  it('endSession is idempotent and never duplicates summary jobs', async () => {
    const session = await runtime.getActiveSession({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });

    const ended1 = await runtime.endSession({ id: session.id, projectId, teamId });
    expect(ended1?.endedAtEpoch).not.toBeNull();
    const firstEndedAt = ended1!.endedAtEpoch;

    // Re-end: should preserve original ended_at because of COALESCE.
    const ended2 = await runtime.endSession({ id: session.id, projectId, teamId });
    expect(ended2?.endedAtEpoch).toBe(firstEndedAt);

    // Now create a summary outbox row twice — UNIQUE on
    // (team_id, project_id, source_type, source_id, job_type) collapses.
    const job1 = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    const job2 = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    expect(job2.id).toBe(job1.id);
  });

  it('listUnprocessedEvents excludes events with completed jobs', async () => {
    const session = await runtime.getActiveSession({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });

    const eventA = await storage.agentEvents.create({
      projectId,
      teamId,
      serverSessionId: session.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(Date.now() - 2000),
    });
    const eventB = await storage.agentEvents.create({
      projectId,
      teamId,
      serverSessionId: session.id,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 2 },
      occurredAt: new Date(),
    });

    // Create a job for eventA and mark it completed.
    const completedJob = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: eventA.id,
      agentEventId: eventA.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_for_event',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: completedJob.id,
      projectId,
      teamId,
      status: 'processing',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: completedJob.id,
      projectId,
      teamId,
      status: 'completed',
    });

    const unprocessed = await runtime.listUnprocessedEvents({
      teamId,
      projectId,
      serverSessionId: session.id,
    });
    expect(unprocessed.map(e => e.id)).toEqual([eventB.id]);
  });

  it('cross-tenant getById returns null', async () => {
    const otherTeam = await storage.teams.create({ name: 'other' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const otherSession = await new PostgresServerSessionsRepository(client).create({
      teamId: otherTeam.id,
      projectId: otherProject.id,
      externalSessionId: 'other-1',
    });

    // Trying to read other team's session under our scope returns null.
    const result = await runtime.getById({
      id: otherSession.id,
      teamId,
      projectId,
    });
    expect(result).toBeNull();
  });

  it('processSessionSummaryResponse persists kind=summary observation idempotently', async () => {
    const session = await runtime.getActiveSession({
      teamId,
      projectId,
      externalSessionId: 'ext-summary',
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'observation_generate_session_summary',
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId,
      teamId,
      status: 'processing',
    });

    const summaryXml = `<summary>
      <request>investigate session</request>
      <investigated>queries and traces</investigated>
      <learned>system behavior</learned>
      <completed>analysis</completed>
      <next_steps>plan refactor</next_steps>
      <notes>none</notes>
    </summary>`;

    const outcome1 = await processSessionSummaryResponse({
      pool,
      job,
      rawText: summaryXml,
      providerLabel: 'claude',
    });
    expect(outcome1.kind).toBe('completed');
    if (outcome1.kind === 'completed') {
      expect(outcome1.observations.length).toBeGreaterThan(0);
      expect(outcome1.observations[0]!.kind).toBe('summary');
    }

    // Idempotent: replaying does not produce new observations because the
    // job is already in completed state.
    const outcome2 = await processSessionSummaryResponse({
      pool,
      job,
      rawText: summaryXml,
      providerLabel: 'claude',
    });
    expect(outcome2.kind).toBe('completed');
    if (outcome2.kind === 'completed') {
      expect(outcome2.observations.length).toBe(0);
    }
  });
});

function makeFakeEvent(id: string, sessionId: string | null) {
  return {
    id,
    projectId: 'p',
    teamId: 't',
    serverSessionId: sessionId,
    sourceAdapter: 'api',
    sourceEventId: null,
    idempotencyKey: 'k',
    eventType: 'tool_use',
    payload: {},
    metadata: {},
    occurredAtEpoch: 0,
    receivedAtEpoch: 0,
    createdAtEpoch: 0,
  };
}

function makeFakeOutbox(id: string, eventId: string) {
  return {
    id,
    projectId: 'p',
    teamId: 't',
    agentEventId: eventId,
    sourceType: 'agent_event' as const,
    sourceId: eventId,
    serverSessionId: null,
    jobType: 'observation_generate_for_event',
    status: 'queued' as const,
    idempotencyKey: 'k',
    bullmqJobId: null,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAtEpoch: null,
    lockedAtEpoch: null,
    lockedBy: null,
    completedAtEpoch: null,
    failedAtEpoch: null,
    cancelledAtEpoch: null,
    lastError: null,
    payload: {},
    createdAtEpoch: 0,
    updatedAtEpoch: 0,
  };
}
