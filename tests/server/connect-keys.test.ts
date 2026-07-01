// SPDX-License-Identifier: Apache-2.0
//
// Key issuance + connect onboarding: POST /v1/keys mints a read-only key for the
// team and GET /v1/connect returns the paste-ready MCP command. Postgres-gated.
//
// The important assertion: a key minted via POST /v1/keys actually authenticates
// against the API (it lands in the same postgres api_keys store readAuth checks).

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

describe('POST /v1/keys + GET /v1/connect', () => {
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
  let readKey: string;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_keys_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (c) => { c.query(`SET search_path TO ${q(schemaName)}`).catch(() => {}); });
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });

    const w = newApiKey(); writeKey = w.raw;
    await storage.auth.createApiKey({ keyHash: w.hash, teamId: team.id, projectId: project.id, actorId: 't', scopes: ['memories:read', 'memories:write'] });
    const r = newApiKey(); readKey = r.raw;
    await storage.auth.createApiKey({ keyHash: r.hash, teamId: team.id, projectId: project.id, actorId: 't', scopes: ['memories:read'] });

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

  it('mints a read-only key whose connect command targets /v1/mcp', async () => {
    const r = await fetch(url('/v1/keys'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 30 }),
    });
    expect(r.status).toBe(201);
    const body = await r.json() as { apiKey: string; scopes: string[]; connectCommand: string; expiresAt: string };
    expect(body.apiKey).toMatch(/^cm_/);
    expect(body.scopes).toEqual(['memories:read']);
    expect(body.connectCommand).toContain('/v1/mcp');
    expect(body.connectCommand).toContain(body.apiKey);
    expect(body.expiresAt).toBeTruthy();
  });

  it('the minted key actually authenticates against the API', async () => {
    const minted = await (await fetch(url('/v1/keys'), {
      method: 'POST', headers: { Authorization: `Bearer ${writeKey}`, 'Content-Type': 'application/json' }, body: '{}',
    })).json() as { apiKey: string };
    const usage = await fetch(url('/v1/usage'), { headers: { Authorization: `Bearer ${minted.apiKey}` } });
    expect(usage.status).toBe(200);
  });

  it('a read-only key cannot mint keys (write scope required)', async () => {
    const r = await fetch(url('/v1/keys'), {
      method: 'POST', headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect([401, 403]).toContain(r.status);
  });

  it('GET /v1/connect returns the command with a placeholder key', async () => {
    const r = await fetch(url('/v1/connect'), { headers: { Authorization: `Bearer ${readKey}` } });
    expect(r.status).toBe(200);
    const body = await r.json() as { connectCommand: string; mcpUrl: string };
    expect(body.mcpUrl).toContain('/v1/mcp');
    expect(body.connectCommand).toContain('<YOUR_API_KEY>');
  });
});
