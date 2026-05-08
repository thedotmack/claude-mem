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

describe('Phase 11 — team/project queue listing endpoints', () => {
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

  // Tenant scaffolding: two teams, two projects in team-A, one project in
  // team-B. Three api keys: team-A team-scoped, team-A project-1-scoped,
  // team-B team-scoped.
  let teamAId: string;
  let teamBId: string;
  let projectA1Id: string;
  let projectA2Id: string;
  let projectB1Id: string;
  let teamAKey: string;
  let projectA1Key: string;
  let teamBKey: string;
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
    schemaName = `cm_phase11_routes_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const teamA = await storage.teams.create({ name: 'team-a' });
    const teamB = await storage.teams.create({ name: 'team-b' });
    const projectA1 = await storage.projects.create({ teamId: teamA.id, name: 'p-a-1' });
    const projectA2 = await storage.projects.create({ teamId: teamA.id, name: 'p-a-2' });
    const projectB1 = await storage.projects.create({ teamId: teamB.id, name: 'p-b-1' });
    teamAId = teamA.id;
    teamBId = teamB.id;
    projectA1Id = projectA1.id;
    projectA2Id = projectA2.id;
    projectB1Id = projectB1.id;

    const teamAKeyMaterial = newApiKey();
    teamAKey = teamAKeyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: teamAKeyMaterial.hash,
      teamId: teamAId,
      projectId: null,
      actorId: 'system:phase11-team-a-key',
      scopes: ['memories:read', 'memories:write'],
    });

    const projectA1KeyMaterial = newApiKey();
    projectA1Key = projectA1KeyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: projectA1KeyMaterial.hash,
      teamId: teamAId,
      projectId: projectA1Id,
      actorId: 'system:phase11-project-a1-key',
      scopes: ['memories:read', 'memories:write'],
    });

    const teamBKeyMaterial = newApiKey();
    teamBKey = teamBKeyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: teamBKeyMaterial.hash,
      teamId: teamBId,
      projectId: null,
      actorId: 'system:phase11-team-b-key',
      scopes: ['memories:read'],
    });

    // Seed two events in projectA1, one in projectA2, one in projectB1.
    // Each event creates a generation_jobs row via storage.observationGenerationJobs.
    for (const projectId of [projectA1Id, projectA1Id, projectA2Id, projectB1Id]) {
      const teamForProject = projectId === projectB1Id ? teamBId : teamAId;
      const event = await storage.agentEvents.create({
        projectId,
        teamId: teamForProject,
        sourceAdapter: 'api',
        eventType: 'tool_use',
        payload: { p: projectId },
        occurredAt: new Date(),
      });
      await storage.observationGenerationJobs.create({
        projectId,
        teamId: teamForProject,
        sourceType: 'agent_event',
        sourceId: event.id,
        agentEventId: event.id,
        jobType: 'observation_generate_for_event',
      });
    }

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

  function authedFetch(rawKey: string, path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  it('GET /v1/teams/:id/jobs returns ALL jobs for the team when called by team-scoped key', async () => {
    const resp = await authedFetch(teamAKey, `/v1/teams/${teamAId}/jobs`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    // 2 jobs in projectA1 + 1 job in projectA2 = 3
    expect(body.total).toBe(3);
    expect(body.jobs.length).toBe(3);
    expect(body.jobs.every((j: any) => j.teamId === teamAId)).toBe(true);
  });

  it('GET /v1/teams/:id/jobs returns 404 when caller is from a different team', async () => {
    const resp = await authedFetch(teamBKey, `/v1/teams/${teamAId}/jobs`);
    expect(resp.status).toBe(404);
  });

  it('GET /v1/teams/:id/jobs filters to project scope when caller is project-scoped', async () => {
    const resp = await authedFetch(projectA1Key, `/v1/teams/${teamAId}/jobs`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(2);
    expect(body.jobs.every((j: any) => j.projectId === projectA1Id)).toBe(true);
  });

  it('GET /v1/projects/:id/jobs returns 404 when project belongs to another team', async () => {
    const resp = await authedFetch(teamAKey, `/v1/projects/${projectB1Id}/jobs`);
    expect(resp.status).toBe(404);
  });

  it('GET /v1/projects/:id/jobs returns 404 when project-scoped key requests another project', async () => {
    const resp = await authedFetch(projectA1Key, `/v1/projects/${projectA2Id}/jobs`);
    expect(resp.status).toBe(404);
  });

  it('GET /v1/projects/:id/jobs allows project-scoped key to read its own project', async () => {
    const resp = await authedFetch(projectA1Key, `/v1/projects/${projectA1Id}/jobs`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(2);
    expect(body.jobs.every((j: any) => j.projectId === projectA1Id)).toBe(true);
  });

  it('GET /v1/projects/:id/jobs allows team-scoped key to read any project under its team', async () => {
    const resp = await authedFetch(teamAKey, `/v1/projects/${projectA2Id}/jobs`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(1);
    expect(body.jobs.every((j: any) => j.projectId === projectA2Id)).toBe(true);
  });

  it('supports status filter, limit, and offset', async () => {
    const resp = await authedFetch(teamAKey, `/v1/teams/${teamAId}/jobs?status=queued&limit=2&offset=0`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(3);
    expect(body.jobs.length).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.jobs.every((j: any) => j.status === 'queued')).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/v1/teams/${teamAId}/jobs`);
    expect(resp.status).toBe(401);
  });
});
