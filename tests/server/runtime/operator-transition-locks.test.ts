import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories, type PostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('operator transitions preserve concurrent generation state', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }
  let pool: pg.Pool;
  let storage: PostgresStorageRepositories;
  let schema: string;
  let server: Server;
  let url: string;
  let rawKey: string;
  let teamId: string;
  let projectId: string;
  let jobId: string;
  let published: string[];
  let removed: string[];
  let onPublish: (() => Promise<void>) | null;
  let gate: { captured: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; armed: boolean; beforeCancelWrite?: boolean } | null;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl!, 'cm_operator_lock');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'operator-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'operator-project' });
    teamId = team.id; projectId = project.id;
    const key = newApiKey(); rawKey = key.raw;
    await storage.auth.createApiKey({ keyHash: key.hash, teamId, projectId, actorId: 'fixture', scopes: ['memories:read', 'memories:write'] });
    const event = await storage.agentEvents.create({ projectId, teamId, sourceAdapter: 'api', eventType: 'tool_use', payload: {}, occurredAt: new Date() });
    jobId = randomUUID();
    await storage.observationGenerationJobs.create({
      id: jobId, projectId, teamId, sourceType: 'agent_event', sourceId: event.id, agentEventId: event.id,
      jobType: 'observation_generate_for_event', bullmqJobId: `event-${event.id}`,
      payload: { kind: 'event', team_id: teamId, project_id: projectId, source_type: 'agent_event', source_id: event.id, generation_job_id: jobId },
    });
    published = []; removed = []; onPublish = null; gate = null;
    // Delay a route read or its cancel UPDATE without changing the database
    // result. A transaction client retains its real Postgres row locks.
    const routeQueryable = <T extends pg.Pool | pg.PoolClient>(queryable: T): T => new Proxy(queryable, {
      get(target, property) {
        if (property === 'connect') return async () => routeQueryable(await pool.connect());
        if (property === 'query') return async (sql: string, values?: unknown[]) => {
          const current = gate;
          if (current?.armed && current.beforeCancelWrite && /UPDATE observation_generation_jobs\s+SET status = 'cancelled'/.test(sql)) {
            current.armed = false;
            current.captured.resolve();
            await current.release.promise;
          }
          const result = await target.query(sql, values);
          if (current?.armed && !current.beforeCancelWrite && /SELECT \*, extract\(epoch from locked_at\)/.test(sql)
            && sql.includes('FROM observation_generation_jobs WHERE id = $1') && !sql.includes('FOR UPDATE')) {
            current.armed = false;
            current.captured.resolve();
            await current.release.promise;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const routePool = routeQueryable(pool);
    const queue = {
      async add(id: string) { published.push(id); await onPublish?.(); },
      async remove(id: string) { removed.push(id); },
      async getJob() { return null; },
    };
    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {}, workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: routePool, queueManager: new DisabledServerQueueManager('fixture'), authMode: 'api-key',
      getEventQueue: () => queue as never, getSummaryQueue: () => queue as never,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(server.getHttpServer()!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    gate?.release.resolve();
    await server.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); }
  });

  const post = (action: 'retry' | 'cancel') => fetch(`${url}/v1/jobs/${jobId}/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const reload = () => storage.observationGenerationJobs.getByIdForScope({ id: jobId, teamId, projectId });
  const status = (next: 'processing' | 'completed' | 'failed') => storage.observationGenerationJobs.transitionStatus({
    id: jobId, teamId, projectId, status: next, lockedBy: 'fixture-worker',
  });
  async function delayed(action: 'retry' | 'cancel'): Promise<{ response: Promise<Response>; release: () => void }> {
    gate = { captured: deferred(), release: deferred(), armed: true };
    const response = post(action);
    await gate.captured.promise;
    return { response, release: gate.release.resolve };
  }
  async function lifecycleCount(eventType: string): Promise<number> {
    const result = await pool.query('SELECT COUNT(*)::int AS n FROM observation_generation_job_events WHERE generation_job_id = $1 AND event_type = $2', [jobId, eventType]);
    return result.rows[0].n;
  }

  for (const winnerState of ['processing', 'completed'] as const) {
    it(`does not retry over a concurrent retry that already reached ${winnerState}`, async () => {
      await status('processing'); await status('failed');
      const first = await delayed('retry');
      onPublish = async () => { await status('processing'); if (winnerState === 'completed') await status('completed'); };
      expect((await post('retry')).status).toBe(200);
      const winning = await reload();
      expect(winning?.status).toBe(winnerState);
      first.release();
      const response = await first.response;
      expect(response.status).toBe(409);
      await response.json();
      const final = await reload();
      expect(final?.status).toBe(winnerState);
      expect(final?.attempts).toBe(winning?.attempts);
      expect(final?.lockedAtToken).toBe(winning?.lockedAtToken);
      expect(published.length).toBe(1);
      expect(await lifecycleCount('queued')).toBe(1);
    });
  }

  it('publishes a concurrent pair of retries only once when the winner is still queued', async () => {
    await status('failed');
    const first = await delayed('retry');
    expect((await post('retry')).status).toBe(200);
    first.release();
    const response = await first.response;
    expect(response.status).toBe(200);
    expect((await response.json() as { alreadyQueued: boolean }).alreadyQueued).toBe(true);
    expect(published.length).toBe(1);
    expect(await lifecycleCount('queued')).toBe(1);
  });

  it('does not cancel a completed job after reading its former processing state', async () => {
    await status('processing');
    const first = await delayed('cancel');
    await status('completed');
    first.release();
    const response = await first.response;
    expect(response.status).toBe(409);
    await response.json();
    expect((await reload())?.status).toBe('completed');
    expect(removed.length).toBe(0);
    expect(await lifecycleCount('cancelled')).toBe(0);
  });

  it('records one cancellation when simultaneous requests saw the same processing job', async () => {
    await status('processing');
    const first = await delayed('cancel');
    expect((await post('cancel')).status).toBe(200);
    first.release();
    const response = await first.response;
    expect(response.status).toBe(200);
    expect((await response.json() as { alreadyCancelled: boolean }).alreadyCancelled).toBe(true);
    expect(removed.length).toBe(1);
    expect(await lifecycleCount('cancelled')).toBe(1);
  });

  it('holds the row through cancellation so completion cannot slip between check and write', async () => {
    await status('processing');
    gate = { captured: deferred(), release: deferred(), armed: true, beforeCancelWrite: true };
    const cancelling = post('cancel');
    await gate.captured.promise;
    const worker = await pool.connect();
    let completion: Promise<void> | null = null;
    try {
      const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let outcome: 'pending' | 'completed' | 'refused' = 'pending';
      completion = createPostgresStorageRepositories(worker).observationGenerationJobs.transitionStatus({
        id: jobId, teamId, projectId, status: 'completed',
      }).then(() => { outcome = 'completed'; }, () => { outcome = 'refused'; });
      // Wait for actual lock contention or completion, not a guessed sleep
      // ordering. The unchanged source completes because it holds no lock.
      let waitingOnLock = false;
      const deadline = Date.now() + 2000;
      while (outcome === 'pending' && !waitingOnLock && Date.now() < deadline) {
        const state = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        waitingOnLock = state.rows[0]?.wait_event_type === 'Lock';
        if (!waitingOnLock) await new Promise(resolve => setTimeout(resolve, 5));
      }
      gate.release.resolve();
      expect((await cancelling).status).toBe(200);
      await completion;
      expect(waitingOnLock).toBe(true);
      expect(outcome as string).toBe('refused');
      expect((await reload())?.status).toBe('cancelled');
    } finally {
      gate.release.resolve();
      await cancelling;
      await completion;
      worker.release();
    }
  });
});
