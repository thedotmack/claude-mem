import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { ServerBetaService } from '../../src/server/runtime/ServerBetaService.js';
import {
  DisabledServerBetaEventBroadcaster,
  DisabledServerBetaGenerationWorkerManager,
  DisabledServerBetaProviderRegistry,
  DisabledServerBetaQueueManager,
  type ServerBetaServiceGraph,
} from '../../src/server/runtime/types.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { logger } from '../../src/utils/logger.js';

const loggerSpies: ReturnType<typeof spyOn>[] = [];
const TEST_DATABASE_URL = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('ServerBetaService', () => {
  let service: ServerBetaService | null = null;

  afterEach(async () => {
    if (service) {
      await service.stop();
      service = null;
    }
    loggerSpies.splice(0).forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('serves server-beta runtime labels from independent runtime routes', async () => {
    loggerSpies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    );

    service = new ServerBetaService({
      graph: createStubGraph(),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).runtime).toBe('server-beta');

    const info = await fetch(`http://127.0.0.1:${address.port}/v1/info`);
    expect(info.status).toBe(200);
    const body = await info.json();
    expect(body.runtime).toBe('server-beta');
    expect(body.boundaries.queueManager.status).toBe('disabled');
  });

  // Phase 4 integration test: Postgres-backed v1 events route must enforce
  // auth, write the event row, create the outbox row, and respond with both
  // event and generationJob. Skipped when no test Postgres URL is set so the
  // unit suite stays green on machines without Postgres available.
  if (TEST_DATABASE_URL) {
    it('writes events and outbox rows transactionally on POST /v1/events', async () => {
      loggerSpies.push(
        spyOn(logger, 'info').mockImplementation(() => {}),
        spyOn(logger, 'debug').mockImplementation(() => {}),
        spyOn(logger, 'warn').mockImplementation(() => {}),
        spyOn(logger, 'error').mockImplementation(() => {}),
      );
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      try {
        await bootstrapServerBetaPostgresSchema(pool);
        const repos = createPostgresStorageRepositories(pool);

        // Set up team / project / api key fixtures.
        const team = await repos.teams.create({ name: `phase4-${Date.now()}` });
        const project = await repos.projects.create({
          teamId: team.id,
          name: `phase4-project-${Date.now()}`,
        });
        const rawKey = `cmem_test_phase4_${Date.now()}`;
        const { createHash } = await import('crypto');
        const keyHash = createHash('sha256').update(rawKey).digest('hex');
        await repos.auth.createApiKey({
          keyHash,
          teamId: team.id,
          actorId: 'test',
          scopes: ['memories:write', 'memories:read'],
        });

        service = new ServerBetaService({
          graph: createPostgresGraph(pool, 'api-key'),
          port: 0,
          host: '127.0.0.1',
          persistRuntimeState: false,
        });
        await service.start();
        const port = service.getRuntimeState().port;

        const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${rawKey}`,
          },
          body: JSON.stringify({
            projectId: project.id,
            sourceType: 'api',
            eventType: 'observation.created',
            payload: { phase: 4 },
            occurredAtEpoch: Date.now(),
          }),
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
      } finally {
        await pool.end();
      }
    });

    it('skips outbox creation when ?generate=false', async () => {
      loggerSpies.push(
        spyOn(logger, 'info').mockImplementation(() => {}),
        spyOn(logger, 'debug').mockImplementation(() => {}),
        spyOn(logger, 'warn').mockImplementation(() => {}),
        spyOn(logger, 'error').mockImplementation(() => {}),
      );
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      try {
        await bootstrapServerBetaPostgresSchema(pool);
        const repos = createPostgresStorageRepositories(pool);
        const team = await repos.teams.create({ name: `phase4-skip-${Date.now()}` });
        const project = await repos.projects.create({
          teamId: team.id,
          name: `phase4-skip-project-${Date.now()}`,
        });
        const rawKey = `cmem_test_phase4_skip_${Date.now()}`;
        const { createHash } = await import('crypto');
        await repos.auth.createApiKey({
          keyHash: createHash('sha256').update(rawKey).digest('hex'),
          teamId: team.id,
          actorId: 'test',
          scopes: ['memories:write', 'memories:read'],
        });

        service = new ServerBetaService({
          graph: createPostgresGraph(pool, 'api-key'),
          port: 0,
          host: '127.0.0.1',
          persistRuntimeState: false,
        });
        await service.start();
        const port = service.getRuntimeState().port;

        const response = await fetch(`http://127.0.0.1:${port}/v1/events?generate=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${rawKey}`,
          },
          body: JSON.stringify({
            projectId: project.id,
            sourceType: 'api',
            eventType: 'observation.created',
            payload: { phase: 4 },
            occurredAtEpoch: Date.now(),
          }),
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
      } finally {
        await pool.end();
      }
    });

    it('rejects mixed-project batches before any side effect', async () => {
      loggerSpies.push(
        spyOn(logger, 'info').mockImplementation(() => {}),
        spyOn(logger, 'debug').mockImplementation(() => {}),
        spyOn(logger, 'warn').mockImplementation(() => {}),
        spyOn(logger, 'error').mockImplementation(() => {}),
      );
      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      try {
        await bootstrapServerBetaPostgresSchema(pool);
        const repos = createPostgresStorageRepositories(pool);
        const team = await repos.teams.create({ name: `phase4-batch-${Date.now()}` });
        const projectA = await repos.projects.create({ teamId: team.id, name: `pa-${Date.now()}` });
        const projectB = await repos.projects.create({ teamId: team.id, name: `pb-${Date.now()}` });
        const rawKey = `cmem_test_phase4_batch_${Date.now()}`;
        const { createHash } = await import('crypto');
        await repos.auth.createApiKey({
          keyHash: createHash('sha256').update(rawKey).digest('hex'),
          teamId: team.id,
          projectId: projectA.id,
          actorId: 'test',
          scopes: ['memories:write', 'memories:read'],
        });

        service = new ServerBetaService({
          graph: createPostgresGraph(pool, 'api-key'),
          port: 0,
          host: '127.0.0.1',
          persistRuntimeState: false,
        });
        await service.start();
        const port = service.getRuntimeState().port;

        const response = await fetch(`http://127.0.0.1:${port}/v1/events/batch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${rawKey}`,
          },
          body: JSON.stringify([
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
          ]),
        });
        expect(response.status).toBe(403);
        const eventCount = await pool.query(
          'SELECT count(*)::int AS count FROM agent_events WHERE team_id = $1',
          [team.id],
        );
        expect((eventCount.rows[0] as { count: number }).count).toBe(0);
      } finally {
        await pool.end();
      }
    });
  } else {
    it.skip('postgres integration tests skipped (set CLAUDE_MEM_TEST_POSTGRES_URL to enable)', () => {});
  }
});

// `createStubGraph` keeps the existing in-process unit test alive without
// requiring a live Postgres. The fake pool's `end()` is the only contract
// touched by ServerBetaService.stop(). The Phase 4 ServerV1PostgresRoutes
// registered in start() do not call the pool until an HTTP request hits
// them; the existing /api/health and /v1/info checks bypass v1 entirely.
function createStubGraph(): ServerBetaServiceGraph {
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
    queueManager: new DisabledServerBetaQueueManager('test'),
    generationWorkerManager: new DisabledServerBetaGenerationWorkerManager('test'),
    providerRegistry: new DisabledServerBetaProviderRegistry('test'),
    eventBroadcaster: new DisabledServerBetaEventBroadcaster('test'),
    storage: {} as any,
  };
}

function createPostgresGraph(pool: pg.Pool, authMode: 'api-key' | 'local-dev'): ServerBetaServiceGraph {
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
    queueManager: new DisabledServerBetaQueueManager('phase 4 integration test'),
    generationWorkerManager: new DisabledServerBetaGenerationWorkerManager('test'),
    providerRegistry: new DisabledServerBetaProviderRegistry('test'),
    eventBroadcaster: new DisabledServerBetaEventBroadcaster('test'),
    storage: createPostgresStorageRepositories(pool as any),
  };
}
