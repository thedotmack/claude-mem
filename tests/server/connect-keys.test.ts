// SPDX-License-Identifier: Apache-2.0
//
// Key issuance + connect onboarding: POST /v1/keys mints a read-only key for the
// team and GET /v1/connect returns the paste-ready MCP command. Postgres-gated.
//
// The important assertion: a key minted via POST /v1/keys actually authenticates
// against the API (it lands in the same postgres api_keys store readAuth checks).

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import http from 'node:http';
import pg from 'pg';
import { randomUUID } from 'crypto';
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
import { newApiKey } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

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
  let teamId: string;
  let projectId: string;
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
    teamId = team.id;
    projectId = project.id;

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
      authMode: 'api-key',
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

  it('answers health while a new key is being derived', async () => {
    // Warm authentication so this probe isolates issuance, not the first-key
    // verifier's own asynchronous derivation.
    const auth = { Authorization: `Bearer ${writeKey}` };
    await (await fetch(url('/v1/connect'), { headers: auth })).json();
    await (await fetch(url('/api/health'))).json();

    const query = pool.query.bind(pool) as (sql: string, values?: unknown[]) => Promise<pg.QueryResult>;
    let health: Promise<number> | undefined;
    let healthAnswered = false;
    let answeredBeforeInsert = false;
    const observed = spyOn(pool, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      if (/INSERT INTO api_keys/.test(sql)) answeredBeforeInsert = healthAnswered;
      const result = await query(sql, values);
      if (!health && /FROM api_keys WHERE id =/.test(sql)) {
        // The cached authorization row has arrived. Submit another real HTTP
        // request just as this handler starts deriving its new key.
        health = fetch(url('/api/health')).then(async response => {
          await response.json();
          healthAnswered = true;
          return response.status;
        });
      }
      return result;
    }) as typeof pool.query);
    try {
      const response = await fetch(url('/v1/keys'), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(201);
      const minted = await response.json() as { apiKey: string };
      expect(await health).toBe(200);
      expect(answeredBeforeInsert).toBe(true);
      const recall = await fetch(url('/v1/connect'), { headers: { Authorization: `Bearer ${minted.apiKey}` } });
      expect(recall.status).toBe(200);
      await recall.text();
    } finally {
      observed.mockRestore();
    }
  });

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

  it('a write-only capture key cannot mint access to existing memories', async () => {
    const captureKey = newApiKey();
    await storage.auth.createApiKey({
      keyHash: captureKey.hash, teamId, projectId, actorId: 'capture', scopes: ['memories:write'],
    });
    const memory = await storage.observations.create({
      teamId, projectId, kind: 'manual', content: 'Existing private project memory',
    });
    const readRequest = () => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${captureKey.raw}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, ids: [memory.id] }),
    });
    const deniedRead = await fetch(url('/v1/observations/batch'), readRequest());
    expect(deniedRead.status).toBe(403);
    await deniedRead.text();

    const countBefore = await client.query('SELECT COUNT(*)::int AS count FROM api_keys');
    const issued = await fetch(url('/v1/keys'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${captureKey.raw}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = await issued.json() as { apiKey?: string };
    expect(issued.status).toBe(403);
    expect(result.apiKey).toBeUndefined();
    expect((await client.query('SELECT COUNT(*)::int AS count FROM api_keys')).rows)
      .toEqual(countBefore.rows);
  });

  it('a wildcard key can mint a read-only key in its existing project scope', async () => {
    const adminKey = newApiKey();
    await storage.auth.createApiKey({
      keyHash: adminKey.hash, teamId, projectId, actorId: 'admin', scopes: ['*'],
    });
    const response = await fetch(url('/v1/keys'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey.raw}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(201);
    const minted = await response.json() as { id: string; scopes: string[] };
    expect(minted.scopes).toEqual(['memories:read']);
    const row = await storage.auth.getApiKeyById(minted.id);
    expect(row?.projectId).toBe(projectId);
    expect(row?.teamId).toBe(teamId);
  });

  it('GET /v1/connect returns the command with a placeholder key', async () => {
    const r = await fetch(url('/v1/connect'), { headers: { Authorization: `Bearer ${readKey}` } });
    expect(r.status).toBe(200);
    const body = await r.json() as { connectCommand: string; mcpUrl: string };
    expect(body.mcpUrl).toContain('/v1/mcp');
    expect(body.connectCommand).toContain('<YOUR_API_KEY>');
  });

  it('refuses a Host header it cannot advertise', async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/connect',
        method: 'GET',
        headers: { Authorization: `Bearer ${readKey}`, Host: 'evil.example with-space' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { error: string }).error).toBe('InvalidHost');
  });
});
