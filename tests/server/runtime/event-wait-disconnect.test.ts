import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories, type PostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('event wait ends when its HTTP client disconnects', () => {
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
  let published: number;
  let polls: number;
  let nextEvent: number;
  let complete: 'none' | 'first' | 'all';
  let firstPublished: ReturnType<typeof deferred>;
  let disconnected: ReturnType<typeof deferred>;
  let pollGate: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null;
  let publishGate: ReturnType<typeof deferred> | null;
  let abort: AbortController | null;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl!, 'cm_wait_disconnect');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'wait-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'wait-project' });
    teamId = team.id; projectId = project.id;
    const key = newApiKey(); rawKey = key.raw;
    await storage.auth.createApiKey({ keyHash: key.hash, teamId, projectId, actorId: 'fixture', scopes: ['memories:read', 'memories:write'] });
    published = 0; polls = 0; nextEvent = 0; complete = 'none'; pollGate = null; publishGate = null; abort = null;
    firstPublished = deferred(); disconnected = deferred();
    const routePool = new Proxy(pool, {
      get(target, property) {
        if (property === 'query') return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (/SELECT \*, extract\(epoch from locked_at\)/.test(sql)
            && sql.includes('FROM observation_generation_jobs WHERE id = $1')) {
            polls++;
            if (polls === 1 && pollGate) {
              pollGate.reached.resolve();
              await pollGate.release.promise;
            }
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const queue = {
      async add(_id: string, payload: { generation_job_id: string }) {
        const index = published++;
        if (complete === 'all' || (complete === 'first' && index === 0)) {
          const scope = { id: payload.generation_job_id, teamId, projectId };
          await storage.observationGenerationJobs.transitionStatus({ ...scope, status: 'processing', lockedBy: 'fixture' });
          await storage.observationGenerationJobs.transitionStatus({ ...scope, status: 'completed' });
        }
        firstPublished.resolve();
        await publishGate?.promise;
      },
      async remove() {}, async getJob() { return null; },
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
    const http = server.getHttpServer()!;
    url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    http.on('request', (req, res) => {
      if (!req.url?.includes('wait=true')) return;
      const socket = req.socket;
      const onClose = () => {
        res.off('close', onClose); socket.off('close', onClose);
        disconnected.resolve();
      };
      res.once('close', onClose); socket.once('close', onClose);
    });
  });

  afterEach(async () => {
    abort?.abort();
    pollGate?.release.resolve();
    publishGate?.resolve();
    // Let unchanged-source regression runs terminate their outstanding
    // polling too, before dropping their isolated database schema.
    await pool.query("UPDATE observation_generation_jobs SET status = 'completed'");
    await sleep(450);
    await server.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); }
  });

  const body = () => ({ projectId, sourceType: 'api', eventType: 'tool_use', payload: { event: ++nextEvent }, occurredAtEpoch: Date.now() });
  const request = (batch = false, generate = true) => {
    abort = new AbortController();
    return fetch(`${url}/v1/events${batch ? '/batch' : ''}?wait=true&generate=${generate}`, {
      method: 'POST', headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch ? [body(), body(), body()] : body()), signal: abort.signal,
    });
  };
  async function disconnect(): Promise<void> {
    abort!.abort();
    await disconnected.promise;
  }
  async function expectCommittedJobs(states: string[]): Promise<void> {
    const jobs = await pool.query('SELECT status FROM observation_generation_jobs ORDER BY created_at, id');
    expect(jobs.rows.map(row => row.status).sort()).toEqual(states.sort());
    const events = await pool.query('SELECT COUNT(*)::int AS n FROM agent_events');
    expect(events.rows[0].n).toBe(states.length);
  }

  it('does not begin status polling after the client leaves during ingest', async () => {
    publishGate = deferred();
    const response = request().catch(error => error);
    await firstPublished.promise;
    await disconnect();
    publishGate.resolve();
    await response;
    await sleep(250);
    expect(polls).toBe(0);
    expect(published).toBe(1);
    await expectCommittedJobs(['queued']);
  });

  it('does not schedule another poll after an in-flight status read returns to a disconnected client', async () => {
    pollGate = { reached: deferred(), release: deferred() };
    const response = request().catch(error => error);
    await pollGate.reached.promise;
    await disconnect();
    pollGate.release.resolve();
    await response;
    await sleep(250);
    expect(polls).toBe(1);
    await expectCommittedJobs(['queued']);
  });

  it('stops a batch before polling its remaining jobs after disconnect', async () => {
    complete = 'first';
    pollGate = { reached: deferred(), release: deferred() };
    const response = request(true).catch(error => error);
    await pollGate.reached.promise;
    expect(published).toBe(3);
    await disconnect();
    pollGate.release.resolve();
    await response;
    await sleep(250);
    expect(polls).toBe(1);
    await expectCommittedJobs(['completed', 'queued', 'queued']);
  });

  it('keeps waiting after a normal POST body finishes and returns the completed generation', async () => {
    complete = 'all';
    const response = await request();
    expect(response.status).toBe(201);
    const result = await response.json() as { generationJob: { status: string }; waitTimedOut?: boolean };
    expect(result.generationJob.status).toBe('completed');
    expect(result.waitTimedOut).toBeUndefined();
    expect(polls).toBe(1);
  });

  it('preserves the no-generation response without polling', async () => {
    const response = await request(false, false);
    expect(response.status).toBe(201);
    expect((await response.json() as { generationJob: unknown }).generationJob).toBe(null);
    expect(polls).toBe(0);
    expect(published).toBe(0);
  });
});
