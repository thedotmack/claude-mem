// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { createIsolatedSchema, dropSchema, poolForSchema, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
describe('POST /v1/memories generationKey', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }
  let pool: pg.Pool;
  let schema: string;
  let server: Server;
  let url: string;
  let projectId: string;
  let apiKey: string;
  let writeOnlyApiKey: string;
  let teamId: string;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl, 'cm_generation_key');
    pool = poolForSchema(databaseUrl, schema);
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'project' });
    projectId = project.id;
    const { raw, hash } = newApiKey();
    apiKey = raw;
    await storage.auth.createApiKey({ keyHash: hash, teamId: team.id, projectId,
      actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    teamId = team.id;
    const writeOnly = newApiKey();
    writeOnlyApiKey = writeOnly.raw;
    await storage.auth.createApiKey({ keyHash: writeOnly.hash, teamId, projectId,
      actorId: 'writer', scopes: ['memories:write'] });
    server = new Server({ getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {}, workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }) });
    server.registerRoutes(new ServerV1PostgresRoutes({ pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'), authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${address.port}/v1/memories`;
  });
  afterEach(async () => {
    try { await server?.close(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await pool?.end();
    if (schema) await dropSchema(databaseUrl, schema);
  });
  function post(extra: Record<string, unknown> = {}, key = apiKey) {
    return fetch(url, { method: 'POST', headers: {
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, content: 'original', ...extra }) });
  }
  async function rowCount() {
    const result = await pool.query('SELECT count(*)::int AS count FROM observations WHERE project_id = $1', [projectId]);
    return result.rows[0].count;
  }
  it('returns the existing observation with 200 for a repeated key', async () => {
    const first = await post({ generationKey: 'import:1' });
    expect(first.status).toBe(201);
    const original = (await first.json()).memory;
    const second = await post({ generationKey: 'import:1', content: 'replacement' });
    expect(second.status).toBe(200);
    const repeated = (await second.json()).memory;
    expect(repeated.id).toBe(original.id);
    expect(repeated.content).toBe('original');
    expect(await rowCount()).toBe(1);
    const audit = await pool.query(
      "SELECT details FROM audit_log WHERE action = 'memory.write' AND resource_id = $1 ORDER BY created_at",
      [original.id],
    );
    expect(audit.rows.map(row => row.details?.outcome ?? null)).toEqual([null, 'existing_generation_key']);
  });
  it('gives a write-only key the existing id but not the stored content', async () => {
    const original = (await (await post({ generationKey: 'import:1' })).json()).memory;
    const repeat = await post({ generationKey: 'import:1', content: 'probe' }, writeOnlyApiKey);
    expect(repeat.status).toBe(200);
    const body = await repeat.json();
    expect(body.existing).toBe(true);
    expect(body.memory.id).toBe(original.id);
    expect(body.memory.content).toBeUndefined();
    expect(await rowCount()).toBe(1);
  });
  it('reserves the generator generationKey namespace', async () => {
    expect((await post({ generationKey: 'generation:v1:x' })).status).toBe(400);
    expect(await rowCount()).toBe(0);
  });
  it('inserts two observations with 201 when generationKey is absent', async () => {
    const first = await post();
    const second = await post();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).memory.id).not.toBe((await first.json()).memory.id);
    expect(await rowCount()).toBe(2);
  });
  it('rejects empty, oversized and non-string generation keys', async () => {
    for (const generationKey of ['', 'x'.repeat(201), 123, null]) {
      expect((await post({ generationKey })).status).toBe(400);
    }
    expect(await rowCount()).toBe(0);
    expect((await post({ generationKey: 'x'.repeat(200) })).status).toBe(201);
  });
});
