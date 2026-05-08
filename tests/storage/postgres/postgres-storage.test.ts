import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  SERVER_BETA_POSTGRES_TABLES,
  bootstrapServerBetaPostgresSchema,
  buildObservationGenerationKey,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories
} from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('server beta postgres schema bootstrap', () => {
  it('acquires and releases a client when bootstrapping from a pool', async () => {
    const queries: string[] = [];
    let released = false;
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      async connect() {
        return {
          release(): void {
            released = true;
          },
          async query(text: string) {
            queries.push(text);
            return { rows: [], rowCount: 0 };
          }
        };
      },
      async query(): Promise<never> {
        throw new Error('pool query should not be used for schema bootstrap');
      }
    };

    await bootstrapServerBetaPostgresSchema(pool);

    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(released).toBe(true);
  });

  it('uses an already-connected pool client without reconnecting it', async () => {
    const queries: string[] = [];
    const client = {
      async connect(): Promise<never> {
        throw new Error('client should not reconnect');
      },
      release(): void {},
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      }
    } as unknown as PostgresPoolClient;

    await bootstrapServerBetaPostgresSchema(client);

    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
  });
});

describe('server beta postgres observation storage', () => {
  if (!testDatabaseUrl) {
    it.skip('requires explicit CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration tests', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_pg_test_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
  });

  afterEach(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      client.release();
    }
  });

  it('creates the Phase 1 schema idempotently', async () => {
    await bootstrapServerBetaPostgresSchema(client);

    const result = await client.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
      `,
      [schemaName]
    );
    const tables = new Set(result.rows.map(row => row.table_name));

    for (const table of SERVER_BETA_POSTGRES_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it('enforces project/team ownership for project-scoped writes', async () => {
    const teamA = await storage.teams.create({ name: 'Team A' });
    const teamB = await storage.teams.create({ name: 'Team B' });
    const projectA = await storage.projects.create({ teamId: teamA.id, name: 'Project A' });

    await expect(storage.projects.create({ teamId: 'missing-team', name: 'Invalid' })).rejects.toThrow();
    await expect(storage.sessions.create({
      projectId: projectA.id,
      teamId: teamB.id
    })).rejects.toThrow(/project_id must belong to team_id/);
  });

  it('deduplicates agent events with deterministic idempotency keys when source event IDs are omitted', async () => {
    const { project, session } = await createFixtureScope(storage);
    const occurredAt = new Date('2026-05-07T20:00:00.000Z');
    const payload = { message: 'same payload', nested: { b: 2, a: 1 } };

    const first = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      sourceAdapter: 'claude-code',
      eventType: 'user_prompt',
      payload,
      occurredAt
    });
    const second = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      sourceAdapter: 'claude-code',
      eventType: 'user_prompt',
      payload: { nested: { a: 1, b: 2 }, message: 'same payload' },
      occurredAt
    });
    const withNativeId = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'cursor',
      sourceEventId: 'event-1',
      eventType: 'tool_call',
      payload: { one: true },
      occurredAt
    });
    const duplicateNativeId = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'cursor',
      sourceEventId: 'event-1',
      eventType: 'tool_call',
      payload: { two: true },
      occurredAt
    });

    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(duplicateNativeId.id).toBe(withNativeId.id);
  });

  it('creates observations, searches content, links sources, and preserves generation retry idempotency', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const generationKey = buildObservationGenerationKey({
      generationJobId: eventJob.id,
      parsedObservationIndex: 0,
      content: 'Postgres is the canonical observation store'
    });

    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Postgres is the canonical observation store',
      generationKey,
      createdByJobId: eventJob.id,
      metadata: { generated: true }
    });
    const retry = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Postgres is the canonical observation store',
      generationKey,
      createdByJobId: eventJob.id
    });
    const source = await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });
    const duplicateSource = await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });
    const search = await storage.observations.search({
      projectId: project.id,
      teamId: project.teamId,
      query: 'canonical observation'
    });

    expect(retry.id).toBe(observation.id);
    expect(source.id).toBe(duplicateSource.id);
    expect(search.map(item => item.id)).toContain(observation.id);
    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toHaveLength(1);
  });

  it('scopes observation generation_key idempotency to project and team', async () => {
    const firstScope = await createFixtureScope(storage);
    const secondScope = await createFixtureScope(storage);
    const generationKey = 'shared-generation-key';

    const first = await storage.observations.create({
      projectId: firstScope.project.id,
      teamId: firstScope.project.teamId,
      content: 'First scoped generation key observation',
      generationKey
    });
    const retry = await storage.observations.create({
      projectId: firstScope.project.id,
      teamId: firstScope.project.teamId,
      content: 'First scoped generation key observation retry',
      generationKey
    });
    const second = await storage.observations.create({
      projectId: secondScope.project.id,
      teamId: secondScope.project.teamId,
      content: 'Second scoped generation key observation',
      generationKey
    });

    expect(retry.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.projectId).toBe(secondScope.project.id);
    expect(second.teamId).toBe(secondScope.project.teamId);
  });

  it('scopes observation source reads to the observation project and team', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Scoped observation source reader'
    });

    await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });

    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toHaveLength(1);
    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toEqual([]);
  });

  it('does not mutate scoped observation source, job transition, or job event writes with the wrong scope', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Wrong-scope mutation guard'
    });

    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    })).rejects.toThrow(/observation_id/);
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      status: 'processing',
      lockedBy: 'wrong-scope-worker'
    })).resolves.toBeNull();
    await expect(storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      eventType: 'processing',
      statusAfter: 'processing'
    })).rejects.toThrow(/generation_job_id must belong/);

    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toEqual([]);
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ status: 'queued', attempts: 0, lockedBy: null });
    await expect(storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toEqual([]);
  });

  it('deduplicates sessions by deterministic identity when external session IDs are omitted', async () => {
    const { project } = await createFixtureScope(storage);

    const first = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      contentSessionId: 'content-session-1',
      agentId: 'agent-1',
      platformSource: 'claude-code',
      metadata: { first: true }
    });
    const second = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      contentSessionId: 'content-session-1',
      agentId: 'agent-1',
      platformSource: 'claude-code',
      metadata: { second: true }
    });

    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.idempotencyKey).not.toBeNull();
  });

  it('exposes scoped getters for auth-visible project resources', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Scoped getter observation',
      createdByJobId: eventJob.id
    });

    await expect(storage.projects.getByIdForTeam(project.id, project.teamId)).resolves.toMatchObject({ id: project.id });
    await expect(storage.sessions.getByIdForScope({
      id: session.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: session.id });
    await expect(storage.agentEvents.getByIdForScope({
      id: event.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: event.id });
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: eventJob.id });
    await expect(storage.observations.getByIdForScope({
      id: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: observation.id });

    await expect(storage.projects.getByIdForTeam(project.id, other.project.teamId)).resolves.toBeNull();
    await expect(storage.sessions.getByIdForScope({
      id: session.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.agentEvents.getByIdForScope({
      id: event.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.observations.getByIdForScope({
      id: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
  });

  it('does not expose unscoped auth-visible getters on exported repositories', async () => {
    for (const repository of [
      storage.projects,
      storage.sessions,
      storage.agentEvents,
      storage.observationGenerationJobs,
      storage.observations,
      storage.observationSources
    ]) {
      const exposed = repository as unknown as Record<string, unknown>;
      expect(exposed.getById).toBeUndefined();
      expect(exposed[['getById', 'Internal'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Status'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Job'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Observation'].join('')]).toBeUndefined();
    }
  });

  it('scopes team lookup by membership', async () => {
    const team = await storage.teams.create({ name: 'Scoped Team' });
    await storage.teams.addMember({ teamId: team.id, userId: 'member-1', role: 'viewer' });

    await expect(storage.teams.getByIdForUser({
      id: team.id,
      userId: 'member-1'
    })).resolves.toMatchObject({ id: team.id });
    await expect(storage.teams.getByIdForUser({
      id: team.id,
      userId: 'outsider'
    })).resolves.toBeNull();
  });

  it('rejects illegal generation job lifecycle transitions and max-attempt retries', async () => {
    const { project, event } = await createFixtureScopeWithEventJob(storage);
    const job = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'single_attempt_generate',
      maxAttempts: 1
    });

    const processing = await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-1'
    });
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'queued',
      nextAttemptAt: new Date('2026-05-07T22:00:00.000Z')
    })).rejects.toThrow(/max_attempts/);
    const failed = await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'failed',
      lastError: { message: 'attempt failed' }
    });

    expect(processing?.attempts).toBe(1);
    expect(failed?.failedAtEpoch).not.toBeNull();
    expect(failed?.completedAtEpoch).toBeNull();
    expect(failed?.cancelledAtEpoch).toBeNull();
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-2'
    })).rejects.toThrow(/terminal status failed/);
  });

  it('allows only one worker to transition a queued generation job to processing', async () => {
    const { eventJob } = await createFixtureScopeWithEventJob(storage);
    let workerA: PostgresPoolClient | null = null;
    let workerB: PostgresPoolClient | null = null;

    try {
      workerA = await pool.connect();
      workerB = await pool.connect();
      await workerA.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await workerB.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      const workerAStorage = createPostgresStorageRepositories(workerA);
      const workerBStorage = createPostgresStorageRepositories(workerB);

      const results = await Promise.allSettled([
        workerAStorage.observationGenerationJobs.transitionStatus({
          id: eventJob.id,
          projectId: eventJob.projectId,
          teamId: eventJob.teamId,
          status: 'processing',
          lockedBy: 'worker-a'
        }),
        workerBStorage.observationGenerationJobs.transitionStatus({
          id: eventJob.id,
          projectId: eventJob.projectId,
          teamId: eventJob.teamId,
          status: 'processing',
          lockedBy: 'worker-b'
        })
      ]);
      const fulfilled = results.filter(result => result.status === 'fulfilled');
      const rejected = results.filter(result => result.status === 'rejected');
      const claimed = await storage.observationGenerationJobs.getByIdForScope({
        id: eventJob.id,
        projectId: eventJob.projectId,
        teamId: eventJob.teamId
      });

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(claimed?.status).toBe('processing');
      expect(claimed?.attempts).toBe(1);
    } finally {
      workerA?.release();
      workerB?.release();
    }
  });

  it('validates server session ownership when creating event generation jobs', async () => {
    const scope = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const siblingSession = await storage.sessions.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      externalSessionId: crypto.randomUUID()
    });

    await expect(storage.observationGenerationJobs.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      sourceType: 'agent_event',
      sourceId: scope.event.id,
      agentEventId: scope.event.id,
      serverSessionId: other.session.id,
      jobType: 'invalid_cross_scope_session'
    })).rejects.toThrow(/server_session_id must belong/);
    await expect(storage.observationGenerationJobs.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      sourceType: 'agent_event',
      sourceId: scope.event.id,
      agentEventId: scope.event.id,
      serverSessionId: siblingSession.id,
      jobType: 'invalid_event_session'
    })).rejects.toThrow(/server_session_id must match/);
  });

  it('requires linked generation jobs to match observation source models', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const secondEvent = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'claude-code',
      sourceEventId: crypto.randomUUID(),
      eventType: 'assistant_response',
      payload: { content: 'second response' },
      occurredAt: new Date('2026-05-07T21:30:00.000Z')
    });
    const secondJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: secondEvent.id,
      agentEventId: secondEvent.id,
      jobType: 'generate_observations'
    });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Observation source model validation'
    });

    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: secondJob.id
    })).rejects.toThrow(/source model/);
    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: secondEvent.id,
      generationJobId: eventJob.id
    })).rejects.toThrow(/source_id must equal agent_event_id/);
  });

  it('validates non-agent observation sources that are not linked through generation jobs', async () => {
    const scope = await createFixtureScope(storage);
    const other = await createFixtureScope(storage);
    const targetObservation = await storage.observations.create({
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      content: 'Target observation for non-agent source validation'
    });
    const sourceObservation = await storage.observations.create({
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      content: 'Source observation for reindex validation'
    });
    const otherObservation = await storage.observations.create({
      projectId: other.project.id,
      teamId: other.project.teamId,
      content: 'Cross-scope source observation'
    });

    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'session_summary',
      sourceId: scope.session.id
    })).resolves.toMatchObject({ sourceType: 'session_summary', sourceId: scope.session.id });
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'observation_reindex',
      sourceId: sourceObservation.id
    })).resolves.toMatchObject({ sourceType: 'observation_reindex', sourceId: sourceObservation.id });
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'session_summary',
      sourceId: other.session.id
    })).rejects.toThrow(/server_session_id must belong/);
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'observation_reindex',
      sourceId: otherObservation.id
    })).rejects.toThrow(/observation_reindex source_id must belong/);
  });

  it('scopes generation job source uniqueness to project and team', async () => {
    const firstScope = await createFixtureScope(storage);
    const secondScope = await createFixtureScope(storage);
    const sharedSourceId = 'shared-source-id';
    const jobType = 'shared_source_generate';

    await client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        firstScope.project.id,
        firstScope.project.teamId,
        sharedSourceId,
        jobType,
        'first-scope-source-key'
      ]
    );
    await client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        secondScope.project.id,
        secondScope.project.teamId,
        sharedSourceId,
        jobType,
        'second-scope-source-key'
      ]
    );
    await expect(client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        firstScope.project.id,
        firstScope.project.teamId,
        sharedSourceId,
        jobType,
        'duplicate-first-scope-source-key'
      ]
    )).rejects.toThrow();
  });

  it('deduplicates generation jobs by source model and records lifecycle events', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const duplicateEventJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'generate_observations'
    });

    const summaryJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'generate_session_summary'
    });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Reindexable observation'
    });
    const reindexJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'observation_reindex',
      sourceId: observation.id,
      jobType: 'reindex_observation'
    });
    const processing = await storage.observationGenerationJobs.transitionStatus({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-1'
    });
    await storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      eventType: 'queued',
      statusAfter: 'queued'
    });
    await storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      eventType: 'processing',
      statusAfter: 'processing',
      attempt: processing?.attempts ?? 1
    });

    const scopedQueuedJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId: project.id,
      teamId: project.teamId
    });
    const wrongScopeQueuedJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId: other.project.id,
      teamId: other.project.teamId
    });
    const lifecycle = await storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    });
    const wrongScopeLifecycle = await storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    });

    expect(duplicateEventJob.id).toBe(eventJob.id);
    expect(summaryJob.sourceType).toBe('session_summary');
    expect(summaryJob.agentEventId).toBeNull();
    expect(summaryJob.serverSessionId).toBe(session.id);
    expect(reindexJob.sourceType).toBe('observation_reindex');
    expect(reindexJob.agentEventId).toBeNull();
    expect(processing?.attempts).toBe(1);
    expect(scopedQueuedJobs.map(job => job.id).sort()).toEqual([summaryJob.id, reindexJob.id].sort());
    expect(wrongScopeQueuedJobs).toEqual([]);
    expect(lifecycle.map(eventRecord => eventRecord.eventType)).toEqual(['queued', 'processing']);
    expect(wrongScopeLifecycle).toEqual([]);
  });
});

async function createFixtureScope(storage: PostgresStorageRepositories) {
  const team = await storage.teams.create({ name: 'Core' });
  const project = await storage.projects.create({ teamId: team.id, name: 'Claude Mem' });
  const session = await storage.sessions.create({
    projectId: project.id,
    teamId: team.id,
    externalSessionId: crypto.randomUUID(),
    platformSource: 'claude-code'
  });

  return { team, project, session };
}

async function createFixtureScopeWithEventJob(storage: PostgresStorageRepositories) {
  const scope = await createFixtureScope(storage);
  const event = await storage.agentEvents.create({
    projectId: scope.project.id,
    teamId: scope.team.id,
    serverSessionId: scope.session.id,
    sourceAdapter: 'claude-code',
    sourceEventId: crypto.randomUUID(),
    eventType: 'assistant_response',
    payload: { content: 'response' },
    occurredAt: new Date('2026-05-07T21:00:00.000Z')
  });
  const eventJob = await storage.observationGenerationJobs.create({
    projectId: scope.project.id,
    teamId: scope.team.id,
    sourceType: 'agent_event',
    sourceId: event.id,
    agentEventId: event.id,
    serverSessionId: scope.session.id,
    jobType: 'generate_observations'
  });

  return { ...scope, event, eventJob };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
