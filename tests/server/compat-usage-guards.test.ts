import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { SessionsObservationsAdapter } from '../../src/server/compat/SessionsObservationsAdapter.js';
import { SessionsSummarizeAdapter } from '../../src/server/compat/SessionsSummarizeAdapter.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../src/storage/postgres/index.js';
import { PostgresUsageRepository } from '../../src/storage/postgres/usage.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier, newApiKey } from '../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const policy = {
  CLAUDE_MEM_RATE_LIMIT_PER_MIN: '2',
  CLAUDE_MEM_MONTHLY_REQUEST_CAP: '50',
  CLAUDE_MEM_MONTHLY_TOKEN_CAP: '100',
  CLAUDE_MEM_USAGE_METERING: '1',
};
const paths = ['/api/sessions/observations', '/api/sessions/summarize'] as const;
const observation = { contentSessionId: 'legacy-session', tool_name: 'Read', tool_use_id: 'read-1' };
const summary = { contentSessionId: 'legacy-session' };

describe('compat routes share configured server admission guards', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }
  let pool: pg.Pool;
  let server: Server;
  let schema: string;
  let url: string;
  let rawKey: string;
  let teamId: string;
  let published: unknown[];
  let previous: Map<string, string | undefined>;

  beforeEach(async () => {
    previous = new Map(Object.keys(policy).map(key => [key, process.env[key]]));
    Object.assign(process.env, policy);
    schema = await createIsolatedSchema(databaseUrl!, 'cm_compat_quota');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'compat-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'compat-project' });
    teamId = team.id;
    const key = newApiKey(); rawKey = key.raw;
    await storage.auth.createApiKey({
      keyHash: key.hash, teamId, projectId: project.id, actorId: 'fixture',
      scopes: ['memories:read', 'memories:write'],
    });
    published = [];
    const queue = {
      async add(_id: string, payload: unknown) { published.push(payload); },
      async getJob() { return null; }, async remove() {},
    };
    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {},
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    const v1 = new ServerV1PostgresRoutes({
      pool, queueManager: new DisabledServerQueueManager('fixture'), authMode: 'api-key',
      getEventQueue: () => queue as never, getSummaryQueue: () => queue as never,
    });
    server.registerRoutes(v1);
    server.registerRoutes(new SessionsObservationsAdapter({ pool, ingestEvents: v1.getIngestEventsService(), authMode: 'api-key' }));
    server.registerRoutes(new SessionsSummarizeAdapter({ pool, endSession: v1.getEndSessionService(), authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(server.getHttpServer()!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await server.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally {
      await pool.end();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  const post = (path: string, body: unknown) => fetch(url + path, {
    method: 'POST', headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function expectNoGeneration(): Promise<void> {
    for (const table of ['server_sessions', 'agent_events', 'observation_generation_jobs']) {
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE team_id = $1`, [teamId]);
      expect(result.rows[0].n).toBe(0);
    }
    expect(published).toEqual([]);
  }

  for (const path of paths) {
    it(`refuses ${path} before creating sessions or generation work at the token cap`, async () => {
      await new PostgresUsageRepository(pool).record({ teamId, kind: 'tokens', quantity: 100 });
      const response = await post(path, path === paths[0] ? observation : summary);
      expect(response.status).toBe(402);
      expect((await response.json() as { error: string }).error).toBe('quota_exceeded');
      await expectNoGeneration();
    });
  }

  it('applies the monthly request cap to both compatibility routes', async () => {
    await new PostgresUsageRepository(pool).record({ teamId, kind: 'request', quantity: 50 });
    for (const path of paths) {
      const response = await post(path, path === paths[0] ? observation : summary);
      expect(response.status).toBe(402);
      expect((await response.json() as { error: string }).error).toBe('quota_exceeded');
    }
    await expectNoGeneration();
  });

  it('uses one per-key rate bucket across canonical and compatibility routes', async () => {
    expect((await post('/v1/events', {})).status).toBe(400);
    expect((await post(paths[0], {})).status).toBe(400);
    const response = await post(paths[1], summary);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('2');
    await response.json();
    await expectNoGeneration();
  });

  it('meters admitted compatibility calls once each and keeps their response shape', async () => {
    for (const [path, body] of [[paths[0], observation], [paths[1], summary]] as const) {
      const response = await post(path, body);
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe('queued');
    }
    const usage = new PostgresUsageRepository(pool);
    let count = 0;
    const deadline = Date.now() + 1000;
    do {
      count = await usage.total({ teamId, kind: 'request', since: new Date(0) });
      if (count === 2) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    expect(count).toBe(2);
    expect(published.length).toBe(2);
  });
});
