// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 SDK contract test — capture()/captureBatch() write exactly one
// agent_events row + one queued observation_generation_jobs row per event,
// in one tx, with no BullMQ/ioredis enqueue. Plan §4.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type pg from 'pg';
import { createCmemClient } from '../../src/sdk/index.js';
import { createIsolatedSchema, poolForSchema, dropSchema } from './pg-isolation.js';

const testDatabaseUrl =
  process.env.CLAUDE_MEM_TEST_POSTGRES_URL ?? process.env.CLAUDE_MEM_SERVER_DATABASE_URL;

describe('CmemClient.capture / captureBatch', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL or CLAUDE_MEM_SERVER_DATABASE_URL', () => {});
    return;
  }

  let dataDir: string;
  let schemaName: string;
  let adminPool: pg.Pool;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `cmem-sdk-capture-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dataDir, { recursive: true });
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    // Each test gets its own schema; the pool pins search_path in the
    // connection startup packet so every pooled connection — including the
    // SDK's bootstrap CREATE TABLEs — is deterministically scoped, with no
    // race against a fire-and-forget SET. See pg-isolation.ts.
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_sdk_cap');
    adminPool = poolForSchema(testDatabaseUrl, schemaName);
  });

  afterEach(async () => {
    await adminPool.end().catch(() => {});
    await dropSchema(testDatabaseUrl, schemaName).catch(() => {});
    if (prevDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('capture(event) writes exactly one agent_event + one queued generation job, in scope', async () => {
    const client = await createCmemClient({ pool: adminPool });
    const result = await client.capture({
      sourceAdapter: 'test-adapter',
      eventType: 'unit_test_capture',
      payload: { content: 'hello cmem' },
    });

    expect(typeof result.agentEventId).toBe('string');
    expect(typeof result.generationJobId).toBe('string');

    const events = await adminPool.query<{
      count: string;
      source_adapter: string;
      event_type: string;
    }>(
      `SELECT count(*)::text AS count, MAX(source_adapter) AS source_adapter, MAX(event_type) AS event_type
       FROM agent_events
       WHERE project_id = $1 AND team_id = $2`,
      [client.projectId, client.teamId]
    );
    expect(events.rows[0]!.count).toBe('1');
    expect(events.rows[0]!.source_adapter).toBe('test-adapter');
    expect(events.rows[0]!.event_type).toBe('unit_test_capture');

    const jobs = await adminPool.query<{
      count: string;
      status: string;
      agent_event_id: string;
    }>(
      `SELECT count(*)::text AS count, MAX(status) AS status, MAX(agent_event_id) AS agent_event_id
       FROM observation_generation_jobs
       WHERE project_id = $1 AND team_id = $2`,
      [client.projectId, client.teamId]
    );
    expect(jobs.rows[0]!.count).toBe('1');
    expect(jobs.rows[0]!.status).toBe('queued');
    expect(jobs.rows[0]!.agent_event_id).toBe(result.agentEventId);

    await client.close();
  });

  it('captureBatch writes one event + one queued job per input', async () => {
    const client = await createCmemClient({ pool: adminPool });
    const events = [
      {
        sourceAdapter: 'batch-test',
        eventType: 'batch_one',
        payload: { i: 1 },
        sourceEventId: 'batch-event-1',
      },
      {
        sourceAdapter: 'batch-test',
        eventType: 'batch_two',
        payload: { i: 2 },
        sourceEventId: 'batch-event-2',
      },
      {
        sourceAdapter: 'batch-test',
        eventType: 'batch_three',
        payload: { i: 3 },
        sourceEventId: 'batch-event-3',
      },
    ];
    const results = await client.captureBatch(events);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(typeof r.agentEventId).toBe('string');
      expect(typeof r.generationJobId).toBe('string');
    }

    const eventCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_events WHERE project_id = $1`,
      [client.projectId]
    );
    expect(eventCount.rows[0]!.count).toBe('3');

    const jobCount = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM observation_generation_jobs WHERE project_id = $1 AND status = 'queued'`,
      [client.projectId]
    );
    expect(jobCount.rows[0]!.count).toBe('3');

    await client.close();
  });

  it('captureBatch with [] is a noop and returns []', async () => {
    const client = await createCmemClient({ pool: adminPool });
    const results = await client.captureBatch([]);
    expect(results).toEqual([]);
    await client.close();
  });
});

// Static-analysis assertion: the SDK module graph does not surface ioredis,
// BullMQ, or Redis client wiring. We can't observe a "would-have-connected"
// attempt directly from a passing test (no Redis to refuse the connection),
// but we CAN check the bundle: the build pipeline already runs
// `node scripts/check-sdk-bundle.cjs` after every npm run build, and that
// script rejects the build outright if ioredis, bullmq, etc., make it into
// `dist/sdk/index.js`. The unit-level check here is the import-source check
// against the source tree on disk, which catches a regression at PR time
// rather than waiting for the build:sdk pipeline.
describe('SDK source bundle — no Redis/BullMQ surface', () => {
  it('src/sdk/index.ts does not import bullmq or ioredis', () => {
    const sdkSource = fs.readFileSync(
      path.join(process.cwd(), 'src/sdk/index.ts'),
      'utf8'
    );
    expect(sdkSource).not.toMatch(/from\s+['"](?:bullmq|ioredis)['"]/);
    expect(sdkSource).not.toMatch(/require\(\s*['"](?:bullmq|ioredis)['"]/);
  });
});
