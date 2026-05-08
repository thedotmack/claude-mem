// SPDX-License-Identifier: Apache-2.0

// Phase 9 — compat adapter tests. Two layers:
//  1. Unit: validate the legacy → AgentEvent translation produced by the
//     adapter when invoked through HTTP, using the same test harness as
//     `tests/server/runtime/server-session-routes.test.ts`.
//  2. Integration: end-to-end through compat → IngestEventsService → Postgres,
//     checking outbox row + BullMQ enqueue captured by a fake queue.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { SessionsObservationsAdapter } from '../../src/server/compat/SessionsObservationsAdapter.js';
import { SessionsSummarizeAdapter } from '../../src/server/compat/SessionsSummarizeAdapter.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerBetaQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('Phase 9 compat adapters', () => {
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
  let projectScopedApiKey: string;
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
    schemaName = `cm_phase9_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team-phase9' });
    const project = await storage.projects.create({ teamId: team.id, name: 'phase9-project' });
    teamId = team.id;
    projectId = project.id;

    // Team-scoped key (no project): /v1/events allowed; compat refused.
    const teamKey = newApiKey();
    apiKeyRaw = teamKey.raw;
    await storage.auth.createApiKey({
      keyHash: teamKey.hash,
      teamId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    // Project-scoped key (required by compat).
    const projKey = newApiKey();
    projectScopedApiKey = projKey.raw;
    await storage.auth.createApiKey({
      keyHash: projKey.hash,
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
    const v1Routes = new ServerV1PostgresRoutes({
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
    });
    server.registerRoutes(v1Routes);
    server.registerRoutes(new SessionsObservationsAdapter({
      pool: pool as never,
      ingestEvents: v1Routes.getIngestEventsService(),
      authMode: 'api-key',
    }));
    server.registerRoutes(new SessionsSummarizeAdapter({
      pool: pool as never,
      endSession: v1Routes.getEndSessionService(),
      authMode: 'api-key',
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

  function authedFetch(rawKey: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  it('POST /api/sessions/observations creates event + outbox + enqueues, with legacy response shape', async () => {
    const response = await authedFetch(projectScopedApiKey, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-session-uuid-1',
        tool_name: 'Read',
        tool_input: { file_path: '/x/y' },
        tool_response: 'ok',
        cwd: '/x',
        platformSource: 'claude-code',
        toolUseId: 'tu_abc',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Legacy clients only check `status`; new clients can read the rest.
    expect(body.status).toBe('queued');
    expect(body.observationCount).toBe(1);
    expect(typeof body.serverSessionId).toBe('string');
    expect(typeof body.eventId).toBe('string');
    expect(body.transport).toBe('enqueued');
    expect(enqueuedEventJobs.length).toBe(1);

    // Confirm the event row landed and references the new server_session.
    const eventRows = await client.query(
      `SELECT id, source_adapter, event_type, server_session_id, payload
       FROM agent_events WHERE id = $1`,
      [body.eventId],
    );
    expect(eventRows.rows.length).toBe(1);
    const evt = eventRows.rows[0] as {
      source_adapter: string;
      event_type: string;
      server_session_id: string;
      payload: { tool_name: string };
    };
    expect(evt.source_adapter).toBe('claude-code-compat');
    expect(evt.event_type).toBe('tool_use');
    expect(evt.server_session_id).toBe(body.serverSessionId);
    expect(evt.payload.tool_name).toBe('Read');

    // Outbox row was created.
    const outboxRows = await client.query(
      `SELECT id, source_type, source_id FROM observation_generation_jobs WHERE agent_event_id = $1`,
      [body.eventId],
    );
    expect(outboxRows.rows.length).toBe(1);
    expect((outboxRows.rows[0] as { source_type: string }).source_type).toBe('agent_event');
  });

  it('POST /api/sessions/observations rejects team-scoped API keys with 400 (project scope required for compat)', async () => {
    const response = await authedFetch(apiKeyRaw, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-session-uuid-2',
        tool_name: 'Read',
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('BadRequest');
    expect(enqueuedEventJobs.length).toBe(0);
  });

  it('POST /api/sessions/observations is idempotent on contentSessionId — same server_session reused', async () => {
    const r1 = await authedFetch(projectScopedApiKey, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-shared-session',
        tool_name: 'Read',
        cwd: '/x',
      }),
    });
    const b1 = await r1.json();

    const r2 = await authedFetch(projectScopedApiKey, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-shared-session',
        tool_name: 'Edit',
        cwd: '/x',
      }),
    });
    const b2 = await r2.json();

    expect(b1.serverSessionId).toBe(b2.serverSessionId);
    // Two events, two outbox rows.
    expect(enqueuedEventJobs.length).toBe(2);
  });

  it('POST /api/sessions/summarize ends server_session and enqueues summary job (legacy response shape)', async () => {
    // Seed an observation first so a server_session exists for this contentSessionId.
    await authedFetch(projectScopedApiKey, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-summarize-session',
        tool_name: 'Read',
        cwd: '/x',
      }),
    });

    const response = await authedFetch(projectScopedApiKey, '/api/sessions/summarize', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-summarize-session',
        last_assistant_message: 'final reply',
        platformSource: 'claude-code',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('queued');
    expect(typeof body.serverSessionId).toBe('string');
    expect(typeof body.generationJobId).toBe('string');
    expect(body.transport).toBe('enqueued');
    expect(enqueuedSummaryJobs.length).toBe(1);

    // Confirm session ended + outbox row.
    const sessionRows = await client.query(
      `SELECT ended_at FROM server_sessions WHERE id = $1`,
      [body.serverSessionId],
    );
    expect(sessionRows.rows.length).toBe(1);
    expect((sessionRows.rows[0] as { ended_at: Date | null }).ended_at).not.toBeNull();

    const outboxRows = await client.query(
      `SELECT source_type FROM observation_generation_jobs WHERE id = $1`,
      [body.generationJobId],
    );
    expect((outboxRows.rows[0] as { source_type: string }).source_type).toBe('session_summary');
  });

  it('POST /api/sessions/summarize with agentId returns subagent_context skip without enqueuing', async () => {
    const response = await authedFetch(projectScopedApiKey, '/api/sessions/summarize', {
      method: 'POST',
      body: JSON.stringify({
        contentSessionId: 'cc-subagent',
        agentId: 'subagent-123',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('subagent_context');
    expect(enqueuedSummaryJobs.length).toBe(0);
  });

  it('POST /api/sessions/summarize is idempotent on re-summarize (same outbox row)', async () => {
    await authedFetch(projectScopedApiKey, '/api/sessions/observations', {
      method: 'POST',
      body: JSON.stringify({ contentSessionId: 'cc-resum', tool_name: 'Read', cwd: '/x' }),
    });
    const r1 = await authedFetch(projectScopedApiKey, '/api/sessions/summarize', {
      method: 'POST',
      body: JSON.stringify({ contentSessionId: 'cc-resum' }),
    });
    const b1 = await r1.json();
    const r2 = await authedFetch(projectScopedApiKey, '/api/sessions/summarize', {
      method: 'POST',
      body: JSON.stringify({ contentSessionId: 'cc-resum' }),
    });
    const b2 = await r2.json();
    expect(b1.generationJobId).toBe(b2.generationJobId);

    const allJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId,
      teamId,
    });
    const summaryJobs = allJobs.filter(j => j.sourceType === 'session_summary');
    expect(summaryJobs.length).toBe(1);
  });

  it('POST /api/sessions/observations rejects requests without auth (401)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: 'x', tool_name: 'Read' }),
    });
    expect(response.status).toBe(401);
    expect(enqueuedEventJobs.length).toBe(0);
  });
});
