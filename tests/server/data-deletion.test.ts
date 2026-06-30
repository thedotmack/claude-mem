// SPDX-License-Identifier: Apache-2.0
//
// Data deletion ("forget"): DELETE /v1/memories/:id and
// DELETE /v1/projects/:projectId/memory. Postgres-gated. Asserts the purge is
// scoped to the team (another team's project is untouched).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;
function newApiKey() {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

describe('data deletion (forget)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let writeKey: string;
  let teamId: string;
  let projectA: string;
  let projectB: string;
  let otherTeamProject: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    // Create the schema first, then give the pool a connection-level search_path
    // (via `options`) so EVERY connection lands in it — no on-connect race, which
    // otherwise makes the auth query miss api_keys and 403.
    schemaName = `cm_del_${randomUUID().replaceAll('-', '_')}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schemaName)}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const a = await storage.projects.create({ teamId, name: 'A' });
    const b = await storage.projects.create({ teamId, name: 'B' });
    projectA = a.id; projectB = b.id;
    for (const projectId of [projectA, projectB]) {
      await storage.observations.create({ projectId, teamId, kind: 'manual', content: `mem ${projectId} 1` });
      await storage.observations.create({ projectId, teamId, kind: 'manual', content: `mem ${projectId} 2` });
    }
    await storage.agentEvents.create({ projectId: projectA, teamId, sourceAdapter: 'api', eventType: 'tool_use', payload: { t: 'ls' }, occurredAt: new Date() });

    // A different team + project — must survive a team-A purge.
    const other = await storage.teams.create({ name: 'other' });
    const op = await storage.projects.create({ teamId: other.id, name: 'O' });
    otherTeamProject = op.id;
    await storage.observations.create({ projectId: op.id, teamId: other.id, kind: 'manual', content: 'other secret' });

    const w = newApiKey(); writeKey = w.raw;
    await storage.auth.createApiKey({ keyHash: w.hash, teamId, projectId: null, actorId: 't', scopes: ['memories:read', 'memories:write'] });

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key', runtime: 'server-beta', sessionPolicy: 'per-event',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const addr = server.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    spies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  // A function, not a constant: writeKey is only set in beforeEach, so a
  // describe-level constant would capture `undefined`.
  const auth = () => ({ Authorization: `Bearer ${writeKey}` });
  const countObs = async (projectId: string) =>
    Number((await pool.query(`SELECT count(*)::int n FROM observations WHERE project_id=$1`, [projectId])).rows[0].n);

  it('purges a project\'s memory and leaves other projects + teams intact', async () => {
    const r = await fetch(url(`/v1/projects/${projectA}/memory`), { method: 'DELETE', headers: auth() });
    expect(r.status).toBe(200);
    const body = await r.json() as { counts: { observations: number; agentEvents: number } };
    expect(body.counts.observations).toBe(2);
    expect(body.counts.agentEvents).toBe(1);
    expect(await countObs(projectA)).toBe(0);
    expect(await countObs(projectB)).toBe(2);         // sibling project untouched
    expect(await countObs(otherTeamProject)).toBe(1); // other team untouched
  });

  it('a team-A key cannot purge another team\'s project (404, deletes nothing)', async () => {
    // The project isn't owned by team A, so the route must 404 rather than report
    // a successful purge of zero rows — otherwise an unauthorized purge looks "done".
    const r = await fetch(url(`/v1/projects/${otherTeamProject}/memory`), { method: 'DELETE', headers: auth() });
    expect(r.status).toBe(404);
    expect(await countObs(otherTeamProject)).toBe(1); // still there
  });

  it('purging a nonexistent project 404s', async () => {
    const r = await fetch(url(`/v1/projects/${randomUUID()}/memory`), { method: 'DELETE', headers: auth() });
    expect(r.status).toBe(404);
  });

  it('deletes a single observation, then 404s on repeat', async () => {
    const id = (await pool.query(`SELECT id FROM observations WHERE project_id=$1 LIMIT 1`, [projectA])).rows[0].id;
    const r1 = await fetch(url(`/v1/memories/${id}`), { method: 'DELETE', headers: auth() });
    expect(r1.status).toBe(200);
    expect(await countObs(projectA)).toBe(1);
    const r2 = await fetch(url(`/v1/memories/${id}`), { method: 'DELETE', headers: auth() });
    expect(r2.status).toBe(404);
  });
});
