import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { ServerService } from '../../src/server/runtime/ServerService.js';
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
