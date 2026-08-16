// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresServerSessionsRepository,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { buildSummaryJobId } from '../../../src/server/runtime/SessionGenerationPolicy.js';
import { processSessionSummaryResponse } from '../../../src/server/generation/processGeneratedResponse.js';
import { quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('SessionGenerationPolicy (pure)', () => {
  it('summary job id is deterministic per server_session_id', () => {
    const a = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const b = buildSummaryJobId({ serverSessionId: 's1', teamId: 't', projectId: 'p' });
    const c = buildSummaryJobId({ serverSessionId: 's2', teamId: 't', projectId: 'p' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain(':');
  });
});

describe('PostgresServerSessionsRepository + Postgres', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let sessions: PostgresServerSessionsRepository;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_phase6_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    sessions = new PostgresServerSessionsRepository(client);

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

  it('create is idempotent on legacy no-platform external_session_id', async () => {
    const a = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    const b = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });
    expect(a.id).toBe(b.id);
    expect(a.externalSessionId).toBe('ext-1');
  });

  it('create scopes external_session_id by normalized platformSource', async () => {
    const cursor = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'Cursor',
    });
    const cursorAgain = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'cursor-cli',
    });
    const codex = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'shared-ext-runtime',
      platformSource: 'Codex CLI',
    });

    expect(cursorAgain.id).toBe(cursor.id);
    expect(cursor.platformSource).toBe('cursor');
    expect(codex.platformSource).toBe('codex');
    expect(codex.id).not.toBe(cursor.id);
  });

  it('endSession is idempotent and never duplicates summary jobs', async () => {
    const session = await sessions.create({
      teamId,
      projectId,
      externalSessionId: 'ext-1',
    });

    const ended1 = await sessions.endSession({ id: session.id, projectId, teamId });
    expect(ended1?.endedAtEpoch).not.toBeNull();
    const firstEndedAt = ended1!.endedAtEpoch;

    // Re-end: should preserve original ended_at because of COALESCE.
    const ended2 = await sessions.endSession({ id: session.id, projectId, teamId });
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
    const session = await sessions.create({
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

    const unprocessed = await sessions.listUnprocessedEvents({
      teamId,
      projectId,
      serverSessionId: session.id,
    });
    expect(unprocessed.map(e => e.id)).toEqual([eventB.id]);
  });

  it('cross-tenant getByIdForScope returns null', async () => {
    const otherTeam = await storage.teams.create({ name: 'other' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const otherSession = await sessions.create({
      teamId: otherTeam.id,
      projectId: otherProject.id,
      externalSessionId: 'other-1',
    });

    // Trying to read other team's session under our scope returns null.
    const result = await sessions.getByIdForScope({
      id: otherSession.id,
      teamId,
      projectId,
    });
    expect(result).toBeNull();
  });

  it('processSessionSummaryResponse persists kind=summary observation idempotently', async () => {
    const session = await sessions.create({
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
