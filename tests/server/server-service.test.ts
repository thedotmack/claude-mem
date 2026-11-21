import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { ServerService } from '../../src/server/runtime/ServerService.js';
import { ActiveServerQueueManager } from '../../src/server/runtime/ActiveServerQueueManager.js';
import type { ServerJobQueue } from '../../src/server/jobs/ServerJobQueue.js';
import type { ServerGenerationJobKind, ServerGenerationJobPayload } from '../../src/server/jobs/types.js';
import {
  DisabledServerGenerationWorkerManager,
  DisabledServerQueueManager,
  type ServerServiceGraph,
} from '../../src/server/runtime/types.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../sdk/pg-isolation.js';
import { logger } from '../../src/utils/logger.js';

const loggerSpies: ReturnType<typeof spyOn>[] = [];
const TEST_DATABASE_URL = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('ServerService', () => {
  let service: ServerService | null = null;
  let pool: pg.Pool | null = null;
  let schemaName: string | null = null;

  beforeEach(() => {
    loggerSpies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    );
  });

  afterEach(async () => {
    try {
      if (service) await service.stop();
      else if (pool) await pool.end();
    } finally {
      service = null;
      pool = null;
      if (schemaName) await dropSchema(TEST_DATABASE_URL!, schemaName);
      schemaName = null;
      loggerSpies.splice(0).forEach(spy => spy.mockRestore());
      mock.restore();
    }
  });

  async function startPostgresService(projectScoped = false) {
    schemaName = await createIsolatedSchema(TEST_DATABASE_URL!, 'cm_server_service');
    pool = poolForSchema(TEST_DATABASE_URL!, schemaName);
    await bootstrapServerPostgresSchema(pool);
    const repos = createPostgresStorageRepositories(pool);
    const team = await repos.teams.create({ name: 'phase4' });
    const project = await repos.projects.create({ teamId: team.id, name: 'phase4-project' });
    const { raw: rawKey, hash: keyHash } = newApiKey();
    await repos.auth.createApiKey({
      keyHash,
      teamId: team.id,
      ...(projectScoped ? { projectId: project.id } : {}),
      actorId: 'test',
      scopes: ['memories:write', 'memories:read'],
    });
    service = new ServerService({
      graph: createPostgresGraph(pool, 'api-key'),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const port = service.getRuntimeState().port;
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify(body),
    });
    return { pool, repos, team, project, post };
  }

  it('serves server-beta runtime labels from independent runtime routes', async () => {
    service = new ServerService({
      graph: createStubGraph(),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.runtime).toBe('server-beta');
    // /api/health is unauthenticated over the container network, so it publishes
    // the same probe state /v1/info does — never the auth mode or the install path.
    expect(healthBody.ai.authMethod).toBeUndefined();
    expect(healthBody.workerPath).toBeUndefined();

    const info = await fetch(`http://127.0.0.1:${address.port}/v1/info`);
    expect(info.status).toBe(200);
    const body = await info.json();
    expect(body.runtime).toBe('server-beta');
    expect(body.boundaries.queueManager.status).toBe('disabled');
    // The route is unauthenticated and reachable over the container network,
    // so it publishes state a probe reads and not the deployment's internals.
    expect(body.authMode).toBeUndefined();
    expect(body.postgres.schemaVersion).toBeUndefined();
    expect(typeof body.postgres.initialized).toBe('boolean');
    expect(Object.keys(body.boundaries.queueManager)).toEqual(['status']);
    expect(Object.keys(body.boundaries.generationWorkerManager)).toEqual(['status']);
    // vectorSearch keeps the shape docs/public/hosted-server.mdx documents.
    expect(typeof body.vectorSearch.available).toBe('boolean');
    expect(typeof body.vectorSearch.model).toBe('string');
    expect(body.vectorSearch).toHaveProperty('observationsWithoutVectors');
    expect(body.vectorSearch).toHaveProperty('lastEmbedError');
    expect(body.vectorSearch.error).toBeUndefined();
  });

  it('logs why /v1/info could not read vector search, while the response leaves the error out', async () => {
    service = new ServerService({
      graph: createStubGraph(),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    // The stub pool refuses every query, so the vector search probe fails.
    const info = await fetch(`http://127.0.0.1:${address.port}/v1/info`);
    expect(info.status).toBe(200);
    const body = await info.json();
    expect(body.vectorSearch.available).toBe(false);
    expect(JSON.stringify(body)).not.toContain('stub pool');
    const vectorWarnings = (logger.warn as unknown as ReturnType<typeof spyOn>).mock.calls
      .filter(call => call[1] === 'Vector search status could not be read for /v1/info');
    expect(vectorWarnings).toHaveLength(1);
    expect(vectorWarnings[0][0]).toBe('SYSTEM');
    expect((vectorWarnings[0][3] as Error).message).toContain('stub pool: query not supported in this test');
  });

  it('leaves the raw lane failure reason out of the unauthenticated /v1/info lanes', async () => {
    // Production reports lane metrics through a real ActiveServerQueueManager.
    // When a lane's counts cannot be read (a Redis blip), the lane surfaces
    // `unavailable` — and the driver's raw error text with it, which the
    // /v1/info route's own comment calls reconnaissance for anyone who can
    // reach the port. /api/health already strips that field (#6309); the
    // unauthenticated /v1/info must not ship it either.
    const failingCounts = 'connect ECONNREFUSED 10.9.8.7:6379';
    const makeQueue = (name: string, failCounts: boolean) => ({
      name,
      add: async () => {},
      remove: async () => {},
      getJob: async () => null,
      getCounts: failCounts
        ? async () => { throw new Error(failingCounts); }
        : async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
      getLifecycleCounters: () => ({ stalled: 0 }),
      start: () => {},
      isStarted: () => false,
      close: async () => {},
    }) as unknown as ServerJobQueue<ServerGenerationJobPayload>;
    const queues = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>([
      ['event', makeQueue('test-event', true)],
      ['summary', makeQueue('test-summary', false)],
    ]);
    const manager = new ActiveServerQueueManager({
      engine: 'bullmq',
      mode: 'managed',
      url: null,
      host: '127.0.0.1',
      port: 6379,
      prefix: 'cmem-test',
      connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
    }, queues);
    service = new ServerService({
      graph: { ...createStubGraph(), queueManager: manager },
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    const info = await fetch(`http://127.0.0.1:${address.port}/v1/info`);
    expect(info.status).toBe(200);
    const body = await info.json();
    expect(body.boundaries.queueManager.status).toBe('active');
    expect(body.queueLanes).toHaveLength(2);
    const failedLane = body.queueLanes.find((lane: { kind: string }) => lane.kind === 'event');
    expect(failedLane.unavailable).toBe(true);
    // The counts stay publishable; the reason text does not.
    expect(failedLane.unavailableReason).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('keeps the lane failure reason on the loopback-only doctor route', async () => {
    // /api/admin/doctor is loopback-only and `claude-mem doctor` reads the
    // recorded failure message for its remediation row, so the strip that
    // protects the unauthenticated /v1/info must not reach this route.
    const failingCounts = 'connect ECONNREFUSED 10.9.8.7:6379';
    const makeQueue = (name: string, failCounts: boolean) => ({
      name,
      add: async () => {},
      remove: async () => {},
      getJob: async () => null,
      getCounts: failCounts
        ? async () => { throw new Error(failingCounts); }
        : async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
      getLifecycleCounters: () => ({ stalled: 0 }),
      start: () => {},
      isStarted: () => false,
      close: async () => {},
    }) as unknown as ServerJobQueue<ServerGenerationJobPayload>;
    const queues = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>([
      ['event', makeQueue('test-event', true)],
      ['summary', makeQueue('test-summary', false)],
    ]);
    const manager = new ActiveServerQueueManager({
      engine: 'bullmq',
      mode: 'managed',
      url: null,
      host: '127.0.0.1',
      port: 6379,
      prefix: 'cmem-test',
      connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
    }, queues);
    service = new ServerService({
      graph: { ...createStubGraph(), queueManager: manager },
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    const doctor = await (await fetch(`http://127.0.0.1:${address.port}/api/admin/doctor`)).json();
    const lanes = doctor.health.queue.lanes as Array<{ kind: string; unavailable?: boolean; unavailableReason?: string }>;
    const failedLane = lanes.find(lane => lane.kind === 'event');
    expect(failedLane.unavailable).toBe(true);
    expect(failedLane.unavailableReason).toBe('connect ECONNREFUSED 10.9.8.7:6379');
  });

  // Phase 4 integration test: Postgres-backed v1 events route must enforce
  // auth, write the event row, create the outbox row, and respond with both
  // event and generationJob. Skipped when no test Postgres URL is set so the
  // unit suite stays green on machines without Postgres available.
  if (TEST_DATABASE_URL) {
    it('writes events and outbox rows transactionally on POST /v1/events', async () => {
      const { team, project, post } = await startPostgresService();
      const response = await post('/v1/events', {
        projectId: project.id,
        sourceType: 'api',
        eventType: 'observation.created',
        payload: { phase: 4 },
        occurredAtEpoch: Date.now(),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.event.projectId).toBe(project.id);
      expect(body.event.teamId).toBe(team.id);
      expect(body.generationJob).toBeDefined();
      expect(body.generationJob.sourceType).toBe('agent_event');
      expect(body.generationJob.sourceId).toBe(body.event.id);
      // No active queue manager: enqueue must report queued_only.
      expect(body.generationJob.transport).toBe('queued_only');
    });

    it('skips outbox creation when ?generate=false', async () => {
      const { pool, project, post } = await startPostgresService();
      const response = await post('/v1/events?generate=false', {
        projectId: project.id,
        sourceType: 'api',
        eventType: 'observation.created',
        payload: { phase: 4 },
        occurredAtEpoch: Date.now(),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.event).toBeDefined();
      expect(body.generationJob).toBeUndefined();

      // Confirm no row in observation_generation_jobs for this event.
      const result = await pool.query(
        'SELECT count(*)::int AS count FROM observation_generation_jobs WHERE agent_event_id = $1',
        [body.event.id],
      );
      expect((result.rows[0] as { count: number }).count).toBe(0);
    });

    it('rejects mixed-project batches before any side effect', async () => {
      const { pool, repos, team, project: projectA, post } = await startPostgresService(true);
      const projectB = await repos.projects.create({ teamId: team.id, name: 'other-project' });
      const response = await post('/v1/events/batch', [
        {
          projectId: projectA.id,
          sourceType: 'api',
          eventType: 'observation.created',
          payload: {},
          occurredAtEpoch: Date.now(),
        },
        {
          projectId: projectB.id,
          sourceType: 'api',
          eventType: 'observation.created',
          payload: {},
          occurredAtEpoch: Date.now(),
        },
      ]);
      expect(response.status).toBe(403);
      const eventCount = await pool.query(
        'SELECT count(*)::int AS count FROM agent_events WHERE team_id = $1',
        [team.id],
      );
      expect((eventCount.rows[0] as { count: number }).count).toBe(0);
    });
  } else {
    it.skip('postgres integration tests skipped (set CLAUDE_MEM_TEST_POSTGRES_URL to enable)', () => {});
  }
});

// `createStubGraph` keeps the existing in-process unit test alive without
// requiring a live Postgres. The fake pool's `end()` is the only contract
// touched by ServerService.stop(). The Phase 4 ServerV1PostgresRoutes
// registered in start() do not call the pool until an HTTP request hits
// them; the existing /api/health and /v1/info checks bypass v1 entirely.
function createStubGraph(): ServerServiceGraph {
  return {
    runtime: 'server-beta',
    postgres: {
      pool: {
        end: mock(() => Promise.resolve()),
        query: mock(() => Promise.reject(new Error('stub pool: query not supported in this test'))),
      } as any,
      bootstrap: {
        initialized: true,
        schemaVersion: 1,
        appliedAt: new Date(0).toISOString(),
      },
    },
    authMode: 'local-dev',
    queueManager: new DisabledServerQueueManager('test'),
    generationWorkerManager: new DisabledServerGenerationWorkerManager('test'),
  };
}

function createPostgresGraph(pool: pg.Pool, authMode: 'api-key' | 'local-dev'): ServerServiceGraph {
  return {
    runtime: 'server-beta',
    postgres: {
      pool: pool as any,
      bootstrap: {
        initialized: true,
        schemaVersion: 1,
        appliedAt: new Date().toISOString(),
      },
    },
    authMode,
    queueManager: new DisabledServerQueueManager('phase 4 integration test'),
    generationWorkerManager: new DisabledServerGenerationWorkerManager('test'),
  };
}
