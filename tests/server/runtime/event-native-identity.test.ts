// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('canonical event HTTP native identity', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schema: string;
  let server: Server;
  let url: string;
  let projectId: string;
  let rawKey: string;
  let spies: ReturnType<typeof spyOn>[];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map(method => spyOn(logger, method as 'info').mockImplementation(() => {}));
    schema = await createIsolatedSchema(databaseUrl!, 'cm_event_native_id');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'event-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'event-project' });
    projectId = project.id;
    const key = newApiKey();
    rawKey = key.raw;
    await storage.auth.createApiKey({ keyHash: key.hash, teamId: team.id, projectId,
      actorId: 'fixture', scopes: ['memories:read', 'memories:write'] });
    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: async () => {}, onRestart: async () => {}, workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool, queueManager: new DisabledServerQueueManager('fixture'), authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(server.getHttpServer()!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await server.close();
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); spies.forEach(spy => spy.mockRestore()); }
  });

  const event = (extra: Record<string, unknown> = {}) => ({
    projectId, sourceType: 'api', eventType: 'tool_use', platformSource: 'claude',
    payload: { tool: 'Read', result: 'fixture' }, occurredAtEpoch: 1_700_000_000_000, ...extra,
  });

  async function send(body: Record<string, unknown>, batch: boolean) {
    return fetch(`${url}/v1/events${batch ? '/batch' : ''}`, {
      method: 'POST', headers: { Authorization: `Bearer ${rawKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch ? [body] : body),
    });
  }

  async function ingest(body: Record<string, unknown>, batch: boolean) {
    const response = await send(body, batch);
    expect(response.status).toBe(201);
    const result = await response.json();
    return batch ? result.events[0] : result;
  }

  async function counts() {
    const result = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM agent_events) AS events,
      (SELECT COUNT(*)::int FROM observation_generation_jobs) AS jobs`);
    return result.rows[0];
  }

  for (const firstBatch of [false, true]) {
    it(`deduplicates a native receipt retried from ${firstBatch ? 'batch to single' : 'single to batch'} with a later delivery timestamp`, async () => {
      const first = await ingest(event({ sourceEventId: 'tool-receipt-1', metadata: { trace: 'trace-1' } }), firstBatch);
      const retry = await ingest(event({ sourceEventId: 'tool-receipt-1',
        occurredAtEpoch: 1_700_000_001_000, metadata: { delivery: 2 } }), !firstBatch);

      expect(retry.event.id).toBe(first.event.id);
      expect(retry.generationJob.id).toBe(first.generationJob.id);
      expect(first.event.sourceEventId).toBe('tool-receipt-1');
      expect(first.event.metadata).toEqual({ trace: 'trace-1' });
      expect(retry.event.metadata).toEqual({ trace: 'trace-1', delivery: 2 });
      expect(retry.event.occurredAtEpoch).toBe(1_700_000_000_000);
      expect(await counts()).toEqual({ events: 1, jobs: 1 });
    });
  }

  it('keeps native receipt IDs scoped to their originating platform', async () => {
    const first = await ingest(event({ sourceEventId: 'tool-receipt-1' }), false);
    const other = await ingest(event({ sourceEventId: 'tool-receipt-1', platformSource: 'cursor' }), true);
    expect(other.event.id).not.toBe(first.event.id);
    expect(await counts()).toEqual({ events: 2, jobs: 2 });
  });

  it('retains content-based replay identity for clients without a native ID', async () => {
    const first = await ingest(event(), false);
    const retry = await ingest(event({ sourceEventId: null }), true);
    expect(retry.event.id).toBe(first.event.id);
    expect(retry.event.sourceEventId).toBeNull();
    expect(await counts()).toEqual({ events: 1, jobs: 1 });
  });

  for (const batch of [false, true]) {
    it(`rejects malformed native identity before ${batch ? 'batch' : 'single'} ingestion`, async () => {
      const response = await send(event({ sourceEventId: 42, metadata: [] }), batch);
      expect(response.status).toBe(400);
      expect(await counts()).toEqual({ events: 0, jobs: 0 });
    });
  }
});
