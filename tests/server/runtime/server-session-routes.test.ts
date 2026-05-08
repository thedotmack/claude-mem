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

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('ServerV1PostgresRoutes Phase 6 session endpoints', () => {
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
  let apiKeyRaw: string;
  let enqueuedEventJobs: { id: string; payload: unknown }[] = [];
  let enqueuedSummaryJobs: { id: string; payload: unknown }[] = [];
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
    schemaName = `cm_phase6_routes_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    enqueuedEventJobs = [];
    enqueuedSummaryJobs = [];

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
      getEventQueue: () => ({
        async add(jobId: string, payload: unknown) {
          enqueuedEventJobs.push({ id: jobId, payload });
        },
        async getJob() { return null; },
        async remove() {},
      }) as never,
      getSummaryQueue: () => ({
        async add(jobId: string, payload: unknown) {
          enqueuedSummaryJobs.push({ id: jobId, payload });
        },
        async getJob() { return null; },
        async remove() {},
      }) as never,
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

  function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${apiKeyRaw}`,
        'Content-Type': 'application/json',
      },
    });
  }

  it('POST /v1/sessions/start is idempotent on (project_id, external_session_id)', async () => {
    const a = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-1' }),
    });
    expect(a.status).toBe(201);
    const aJson = await a.json();
    const b = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-1' }),
    });
    expect(b.status).toBe(200);
    const bJson = await b.json();
    expect(bJson.session.id).toBe(aJson.session.id);
  });

  it('POST /v1/sessions/:id/end enqueues exactly one summary job, idempotent on re-end', async () => {
    const startResp = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-end' }),
    });
    const { session } = await startResp.json();

    const end1 = await authedFetch(`/v1/sessions/${session.id}/end`, { method: 'POST' });
    expect(end1.status).toBe(200);
    const end1Json = await end1.json();
    expect(end1Json.generationJob.sourceType).toBe('session_summary');
    expect(end1Json.session.endedAtEpoch).not.toBeNull();
    expect(enqueuedSummaryJobs.length).toBe(1);

    const end2 = await authedFetch(`/v1/sessions/${session.id}/end`, { method: 'POST' });
    expect(end2.status).toBe(200);
    const end2Json = await end2.json();
    // Same generation job id (UNIQUE collapse).
    expect(end2Json.generationJob.id).toBe(end1Json.generationJob.id);
    // Re-ending may still publish to the queue (BullMQ add() is idempotent on
    // jobId), but the outbox row count is unchanged. We assert the outbox
    // collapse rather than queue-publish count.
    const allJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId,
      teamId,
    });
    const summaryJobs = allJobs.filter(j => j.sourceType === 'session_summary');
    expect(summaryJobs.length).toBe(1);
  });

  it('GET /v1/sessions/:id returns 404 for cross-project requests', async () => {
    // Create a foreign project + session under a different team.
    const otherTeam = await storage.teams.create({ name: 'other' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'other-p' });
    const otherSession = await storage.sessions.create({
      teamId: otherTeam.id,
      projectId: otherProject.id,
      externalSessionId: 'foreign',
    });

    const resp = await authedFetch(`/v1/sessions/${otherSession.id}`);
    expect(resp.status).toBe(404);
  });

  it('POST /v1/events with per-event policy enqueues immediately', async () => {
    const startResp = await authedFetch('/v1/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ projectId, externalSessionId: 'ext-evt' }),
    });
    const { session } = await startResp.json();

    const eventResp = await authedFetch('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        serverSessionId: session.id,
        sourceType: 'api',
        eventType: 'tool_use',
        payload: { tool: 'read' },
        occurredAtEpoch: Date.now(),
      }),
    });
    expect(eventResp.status).toBe(201);
    expect(enqueuedEventJobs.length).toBe(1);
  });
});
