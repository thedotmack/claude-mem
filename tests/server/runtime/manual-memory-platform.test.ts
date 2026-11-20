// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { ServerViewerRoutes } from '../../../src/server/runtime/ServerViewerRoutes.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories, type PostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('manual memories retain their supplied platform', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  let pool: pg.Pool;
  let storage: PostgresStorageRepositories;
  let schema: string;
  let server: Server;
  let url: string;
  let projectId: string;
  let teamId: string;
  let rawKey: string;
  let spies: ReturnType<typeof spyOn>[];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map(method => spyOn(logger, method as 'info').mockImplementation(() => {}));
    schema = await createIsolatedSchema(databaseUrl!, 'cm_manual_platform');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'memory-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'memory-project' });
    teamId = team.id; projectId = project.id;
    const key = newApiKey(); rawKey = key.raw;
    await storage.auth.createApiKey({ keyHash: key.hash, teamId, projectId,
      actorId: 'fixture', scopes: ['memories:read', 'memories:write'] });
    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {}, workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool, queueManager: new DisabledServerQueueManager('fixture'), authMode: 'api-key',
    }));
    server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(server.getHttpServer()!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await server.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); spies.forEach(spy => spy.mockRestore()); }
  });

  async function request(path: string, body?: Record<string, unknown>) {
    const response = await fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify({ projectId, ...body }) } : {}),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }
  const save = (extra: Record<string, unknown> = {}) => request('/v1/memories', { content: 'Quasar release plan', ...extra });
  async function recalled(platformSource: string) {
    const search = await request('/v1/search', { query: 'Quasar', platformSource });
    const context = await request('/v1/context', { platformSource });
    return [search.observations.map((row: { id: string }) => row.id), context.observations.map((row: { id: string }) => row.id)];
  }

  for (const extra of [{}, { contentSessionId: 'not-created-yet', kind: 'summary' }]) {
    it(`can recall a saved platform-specific note ${'contentSessionId' in extra ? 'before session creation' : 'without a session'}`, async () => {
      const { memory } = await save({ ...extra, platformSource: 'Cursor IDE', metadata: { title: 'Quasar', project: 'checkout', platformSource: 'stale-source' } });
      expect(memory.serverSessionId).toBeNull();
      expect(await recalled('cursor')).toEqual([[memory.id], [memory.id]]);
      expect(memory.metadata).toMatchObject({ platformSource: 'cursor', title: 'Quasar', project: 'checkout' });
      expect(await recalled('codex')).toEqual([[], []]);
      const feed = await request(`/api/${'kind' in extra ? 'summaries' : 'observations'}?platformSource=cursor`);
      expect(feed.items).toEqual([expect.objectContaining({ id: memory.id, platform_source: 'cursor' })]);
      const catalog = await request('/api/projects');
      expect(catalog.sources).toEqual(['cursor']);
      expect(catalog.projectsBySource.cursor).toEqual(['checkout']);
      const counts = await pool.query(`SELECT (SELECT COUNT(*)::int FROM server_sessions) AS sessions,
        (SELECT COUNT(*)::int FROM observation_generation_jobs) AS jobs`);
      expect(counts.rows[0]).toEqual({ sessions: 0, jobs: 0 });
    });
  }

  it('keeps a linked session authoritative over supplied memory metadata', async () => {
    const session = await storage.sessions.create({ projectId, teamId, platformSource: 'codex' });
    const { memory } = await save({ serverSessionId: session.id, platformSource: 'cursor' });
    expect(await recalled('codex')).toEqual([[memory.id], [memory.id]]);
    expect(await recalled('cursor')).toEqual([[], []]);
    const feed = await request('/api/observations?platformSource=codex');
    expect(feed.items).toEqual([expect.objectContaining({ id: memory.id, platform_source: 'codex' })]);
    expect((await request('/api/projects')).sources).toEqual(['codex']);
  });

  it('does not relabel a generation-key replay from another platform', async () => {
    const { memory } = await save({ generationKey: 'saved-note', platformSource: 'cursor' });
    const retry = await save({ generationKey: 'saved-note', platformSource: 'codex' });
    expect(retry.memory.id).toBe(memory.id);
    expect(await recalled('cursor')).toEqual([[memory.id], [memory.id]]);
    expect(await recalled('codex')).toEqual([[], []]);
  });

  it('keeps project and team boundaries around unlinked platform reads', async () => {
    const otherProject = await storage.projects.create({ teamId, name: 'other-project' });
    const otherTeam = await storage.teams.create({ name: 'other-team' });
    const foreignProject = await storage.projects.create({ teamId: otherTeam.id, name: 'foreign-project' });
    for (const scope of [{ teamId, projectId: otherProject.id }, { teamId: otherTeam.id, projectId: foreignProject.id }]) {
      await storage.observations.create({ ...scope, content: 'Quasar elsewhere', metadata: { platformSource: 'cursor' } });
    }
    const { memory } = await save({ platformSource: 'cursor' });
    expect(await recalled('cursor')).toEqual([[memory.id], [memory.id]]);
    const feed = await request('/api/observations?platformSource=cursor');
    expect(feed.items.map((row: { id: string }) => row.id)).toEqual([memory.id]);
    expect((await request('/api/projects')).projects).toEqual(['memory-project']);
  });

  it('keeps unlabelled legacy rows on the existing viewer default', async () => {
    const { memory } = await save();
    expect(await recalled('cursor')).toEqual([[], []]);
    expect((await request('/api/observations')).items).toEqual([
      expect.objectContaining({ id: memory.id, platform_source: 'claude' }),
    ]);
  });
});
