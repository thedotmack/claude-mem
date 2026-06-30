// SPDX-License-Identifier: Apache-2.0
//
// Paid-readiness primitives: usage metering, per-key rate limiting, monthly
// quota, and the GET /v1/usage endpoint. Postgres-gated (CLAUDE_MEM_TEST_POSTGRES_URL).
//
// The repo + middleware logic is tested directly (deterministic). One full
// server boot proves the array-middleware wiring (readAuth = [auth, ...guards])
// actually serves GET /v1/usage end to end.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresUsageRepository,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { requireRateLimit, requireMonthlyQuota } from '../../src/server/middleware/rate-limit.js';
import { meterRequests } from '../../src/server/middleware/usage-metering.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

// Minimal Express req/res/next doubles for middleware unit tests.
function fakeCtx(authContext: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const out: { status?: number; body?: unknown; nexted: boolean } = { nexted: false };
  const req = { authContext, method: 'GET', path: '/v1/x' } as unknown as Request;
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  const next: NextFunction = () => { out.nexted = true; };
  return { req, res, next, out, headers };
}

describe('paid-readiness (usage metering, rate limit, quota)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let apiKeyId: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = ['info', 'warn', 'error', 'debug'].map((m) =>
      spyOn(logger, m as 'info').mockImplementation(() => {}),
    );
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_paid_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (c) => { c.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {}); });
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const { raw, hash } = newApiKey();
    const key = await storage.auth.createApiKey({ keyHash: hash, teamId, projectId, actorId: 't', scopes: ['memories:read'] });
    apiKeyId = key.id;
    void raw;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  it('usage repo records and aggregates per kind', async () => {
    const usage = new PostgresUsageRepository(pool as never);
    await usage.record({ teamId, kind: 'request' });
    await usage.record({ teamId, kind: 'request' });
    await usage.record({ teamId, kind: 'tokens_in', quantity: 500 });
    const since = new Date(Date.now() - 60_000);
    expect(await usage.total({ teamId, kind: 'request', since })).toBe(2);
    const summary = await usage.summarize({ teamId, since });
    expect(summary.request).toBe(2);
    expect(summary.tokens_in).toBe(500);
  });

  it('rate limiter allows up to max then 429s', async () => {
    const mw = requireRateLimit(pool as never, { windowSec: 60, max: 3 });
    const ctx = () => fakeCtx({ apiKeyId, teamId });
    for (let i = 0; i < 3; i++) {
      const c = ctx();
      await mw(c.req, c.res, c.next);
      expect(c.out.nexted).toBe(true);
      expect(c.out.status).toBeUndefined();
    }
    const blocked = ctx();
    await mw(blocked.req, blocked.res, blocked.next);
    expect(blocked.out.nexted).toBe(false);
    expect(blocked.out.status).toBe(429);
    expect(blocked.headers['Retry-After']).toBeDefined();
    expect(blocked.headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('rate limiter skips requests with no api key (local-dev)', async () => {
    const mw = requireRateLimit(pool as never, { windowSec: 60, max: 1 });
    const c = fakeCtx({ teamId }); // no apiKeyId
    await mw(c.req, c.res, c.next);
    await mw(c.req, c.res, c.next);
    expect(c.out.status).toBeUndefined(); // never limited
  });

  it('monthly quota 402s once usage reaches the cap', async () => {
    const usage = new PostgresUsageRepository(pool as never);
    await usage.record({ teamId, kind: 'request', quantity: 5 });
    const mw = requireMonthlyQuota(pool as never, { kind: 'request', cap: 5 });
    const c = fakeCtx({ apiKeyId, teamId });
    await mw(c.req, c.res, c.next);
    expect(c.out.nexted).toBe(false);
    expect(c.out.status).toBe(402);
  });

  it('monthly quota passes when under the cap', async () => {
    const usage = new PostgresUsageRepository(pool as never);
    await usage.record({ teamId, kind: 'request', quantity: 2 });
    const mw = requireMonthlyQuota(pool as never, { kind: 'request', cap: 5 });
    const c = fakeCtx({ apiKeyId, teamId });
    await mw(c.req, c.res, c.next);
    expect(c.out.nexted).toBe(true);
    expect(c.out.status).toBeUndefined();
  });

  it('meterRequests records a request event (fire-and-forget)', async () => {
    const mw = meterRequests(pool as never);
    const c = fakeCtx({ apiKeyId, teamId, projectId });
    mw(c.req, c.res, c.next);
    expect(c.out.nexted).toBe(true); // never blocks
    await new Promise((r) => setTimeout(r, 100)); // let the background insert land
    const n = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE team_id = $1 AND kind = 'request'`, [teamId]);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('GET /v1/usage returns the team usage (array-middleware wiring works)', async () => {
    await new PostgresUsageRepository(pool as never).record({ teamId, kind: 'observation', quantity: 3 });
    const { raw, hash } = newApiKey();
    await storage.auth.createApiKey({ keyHash: hash, teamId, projectId, actorId: 't', scopes: ['memories:read'] });

    const server = new Server({
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
    try {
      const r = await fetch(`http://127.0.0.1:${addr.port}/v1/usage`, { headers: { Authorization: `Bearer ${raw}` } });
      expect(r.status).toBe(200);
      const body = await r.json() as { usage: Record<string, number> };
      expect(body.usage.observation).toBe(3);
    } finally {
      try { await server.close(); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      }
    }
  });
});
