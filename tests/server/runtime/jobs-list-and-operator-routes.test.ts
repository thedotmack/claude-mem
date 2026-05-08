// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerBetaQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

// Phase 12 — integration tests for GET /v1/jobs (with admin payload guard),
// POST /v1/jobs/:id/retry, POST /v1/jobs/:id/cancel. Postgres-gated; skipped
// without CLAUDE_MEM_TEST_POSTGRES_URL.

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('Phase 12 — GET /v1/jobs + retry/cancel routes', () => {
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

  let teamId: string;
  let projectId: string;
  let writeKey: string;
  let adminKey: string;
  let jobId: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_phase12_jobs_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (c) => {
      c.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p1' });
    teamId = team.id;
    projectId = project.id;

    const writeMaterial = newApiKey();
    writeKey = writeMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: writeMaterial.hash,
      teamId,
      projectId: null,
      actorId: 'system:phase12-write',
      scopes: ['memories:read', 'memories:write'],
    });

    const adminMaterial = newApiKey();
    adminKey = adminMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: adminMaterial.hash,
      teamId,
      projectId: null,
      actorId: 'system:phase12-admin',
      scopes: ['memories:read', 'memories:write', 'memories:admin'],
    });

    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { sensitive: 'should_not_leak' },
      occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
      payload: { sensitive: 'should_not_leak', request_id: 'req-12345' },
    });
    jobId = job.id;

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerBetaQueueManager('disabled in tests'),
      authMode: 'api-key',
      runtime: 'server-beta',
      sessionPolicy: 'per-event',
      getEventQueue: () => null,
      getSummaryQueue: () => null,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function authedFetch(rawKey: string, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...(init ?? {}),
      headers: {
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });
  }

  it('GET /v1/jobs lists jobs without payload by default', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { jobs: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.jobs[0]!.payload).toBeUndefined();
  });

  it('GET /v1/jobs?include=payload rejects without admin scope', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs?include=payload');
    expect(resp.status).toBe(403);
  });

  it('GET /v1/jobs?include=payload succeeds with admin scope and returns payload', async () => {
    const resp = await authedFetch(adminKey, '/v1/jobs?include=payload');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { jobs: Array<Record<string, unknown>> };
    const payload = body.jobs[0]!.payload as { sensitive: string; request_id?: string };
    expect(payload.sensitive).toBe('should_not_leak');
    expect(payload.request_id).toBe('req-12345');
  });

  it('GET /v1/jobs supports source_type and since filters', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const resp = await authedFetch(writeKey, `/v1/jobs?source_type=agent_event&since=${future}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { total: number };
    expect(body.total).toBe(0);
  });

  it('POST /v1/jobs/:id/retry on a queued job is a no-op', async () => {
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { alreadyQueued: boolean };
    expect(body.alreadyQueued).toBe(true);
    // Idempotent: a second call also reports already queued.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json() as { alreadyQueued: boolean };
    expect(body2.alreadyQueued).toBe(true);
  });

  it('POST /v1/jobs/:id/retry on a failed job re-queues idempotently', async () => {
    // Force the row into failed.
    await client.query(
      `UPDATE observation_generation_jobs SET status = 'failed', failed_at = now() WHERE id = $1`,
      [jobId],
    );
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      alreadyQueued: boolean;
      retriedCount: number;
      generationJob: { status: string };
    };
    expect(body.alreadyQueued).toBe(false);
    expect(body.retriedCount).toBe(1);
    expect(body.generationJob.status).toBe('queued');

    // Second retry on now-queued row is a no-op.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    const body2 = await resp2.json() as { alreadyQueued: boolean };
    expect(body2.alreadyQueued).toBe(true);

    // Audit row written.
    const audit = await client.query(
      `SELECT * FROM audit_log WHERE action = 'generation_job.retried_by_operator' AND resource_id = $1`,
      [jobId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /v1/jobs/:id/cancel cancels a queued job and emits audit', async () => {
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { generationJob: { status: string }; alreadyCancelled: boolean };
    expect(body.alreadyCancelled).toBe(false);
    expect(body.generationJob.status).toBe('cancelled');

    // Idempotent.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    const body2 = await resp2.json() as { alreadyCancelled: boolean };
    expect(body2.alreadyCancelled).toBe(true);

    const audit = await client.query(
      `SELECT * FROM audit_log WHERE action = 'generation_job.cancelled_by_operator' AND resource_id = $1`,
      [jobId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('request_id flows from header into audit details', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs', {
      headers: { 'X-Request-Id': 'op-correlation-007' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-request-id')).toBe('op-correlation-007');
    const body = await resp.json() as { requestId: string };
    expect(body.requestId).toBe('op-correlation-007');

    const audit = await client.query(
      `SELECT details FROM audit_log WHERE action = 'observation.read' ORDER BY created_at DESC LIMIT 1`,
    );
    const details = audit.rows[0]?.details as { requestId?: string };
    expect(details?.requestId).toBe('op-correlation-007');
  });
});
