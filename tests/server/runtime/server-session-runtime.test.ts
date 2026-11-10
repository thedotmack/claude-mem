// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresServerSessionsRepository,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { processSessionSummaryResponse } from '../../../src/server/generation/processGeneratedResponse.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('PostgresServerSessionsRepository + Postgres', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let sessions: PostgresServerSessionsRepository;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase6');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
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
      await pool.end();
    }
  });

  it('re-ending a session preserves the first ended_at', async () => {
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
  });

  it('processSessionSummaryResponse persists a kind=summary observation', async () => {
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
    // The response belongs to the processing attempt it was generated for.
    const processing = (await storage.observationGenerationJobs.getByIdForScope({
      id: job.id,
      projectId,
      teamId,
    }))!;

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
      job: processing,
      rawText: summaryXml,
      providerLabel: 'claude',
    });
    expect(outcome1.kind).toBe('completed');
    if (outcome1.kind === 'completed') {
      expect(outcome1.observations.length).toBeGreaterThan(0);
      expect(outcome1.observations[0]!.kind).toBe('summary');
    }
  });
});
