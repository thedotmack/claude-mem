// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { reclaimStaleProcessingJobs } from '../../../src/server/generation/reclaimStaleProcessingJobs.js';
import { ActiveServerGenerationWorkerManager } from '../../../src/server/runtime/ActiveServerGenerationWorkerManager.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier } from '../../sdk/pg-isolation.js';

// A worker that dies mid-job leaves its outbox row in `processing`. These
// tests hold that state open (a backdated lock) and check the sweep returns
// the row to the queue, or fails it once its attempts are spent. Postgres-
// gated; skipped without CLAUDE_MEM_TEST_POSTGRES_URL.

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const STALE_AFTER_MS = 15 * 60 * 1000;

describe('reclaimStaleProcessingJobs', () => {
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
  let published: { op: 'add' | 'remove'; jobId: string }[];
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  const queue = {
    add: async (jobId: string) => { published.push({ op: 'add', jobId }); },
    remove: async (jobId: string) => { published.push({ op: 'remove', jobId }); },
  };

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    published = [];
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
    client = await pool.connect();
    schemaName = `cm_reclaim_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p1' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  async function processingJob(lockAgeMs: number, attempts?: number): Promise<string> {
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: {},
      occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
      bullmqJobId: `bull-${event.id}`,
      payload: { generation_job_id: 'x' },
    });
    await storage.observationGenerationJobs.transitionStatus({
      id: job.id, projectId, teamId, status: 'processing', lockedBy: 'dead-worker',
    });
    await client.query(
      `UPDATE observation_generation_jobs
       SET locked_at = now() - ($2::double precision * interval '1 millisecond'),
           attempts = COALESCE($3, attempts)
       WHERE id = $1`,
      [job.id, lockAgeMs, attempts ?? null],
    );
    return job.id;
  }

  async function row(id: string) {
    const result = await client.query(
      'SELECT status, attempts, locked_at, last_error, bullmq_job_id FROM observation_generation_jobs WHERE id = $1',
      [id],
    );
    return result.rows[0];
  }

  function reclaim() {
    return reclaimStaleProcessingJobs({
      pool: client,
      staleAfterMs: STALE_AFTER_MS,
      resolveQueue: () => queue,
    });
  }

  it('returns a dead worker\'s job to the queue and republishes it', async () => {
    const id = await processingJob(STALE_AFTER_MS + 60_000);

    expect(await reclaim()).toEqual({ requeued: 1, failed: 0 });

    const after = await row(id);
    expect(after.status).toBe('queued');
    expect(after.locked_at).toBeNull();
    expect(published).toEqual([
      { op: 'remove', jobId: after.bullmq_job_id },
      { op: 'add', jobId: after.bullmq_job_id },
    ]);
    const events = await client.query(
      'SELECT event_type, details FROM observation_generation_job_events WHERE generation_job_id = $1 ORDER BY created_at DESC LIMIT 1',
      [id],
    );
    expect(events.rows[0].event_type).toBe('queued');
    expect(events.rows[0].details.source).toBe('stale_lock_reclaim');
  });

  it('fails a stale job that has used every attempt instead of looping it', async () => {
    const id = await processingJob(STALE_AFTER_MS + 60_000, 3);

    expect(await reclaim()).toEqual({ requeued: 0, failed: 1 });

    const after = await row(id);
    expect(after.status).toBe('failed');
    expect(after.last_error.reason).toBe('stale_processing_lock');
    expect(after.last_error.lockedBy).toBe('dead-worker');
    expect(published).toEqual([]);
  });

  it('leaves a job whose lock is younger than the threshold alone', async () => {
    const id = await processingJob(STALE_AFTER_MS - 60_000);

    expect(await reclaim()).toEqual({ requeued: 0, failed: 0 });

    expect((await row(id)).status).toBe('processing');
    expect(published).toEqual([]);
  });

  it('sweeps once when the generation worker starts', async () => {
    const lockDurationMs = 5 * 60 * 1000;
    const id = await processingJob(3 * lockDurationMs + 60_000);
    const lane = { ...queue, observe: () => {}, getLockDurationMs: () => lockDurationMs };
    const manager = new ActiveServerGenerationWorkerManager({
      pool: client as never,
      queueManager: { start: () => {}, getQueue: () => lane } as never,
      provider: {} as never,
    });

    manager.start();
    try {
      for (let i = 0; i < 50 && (await row(id)).status === 'processing'; i++) {
        await Bun.sleep(20);
      }
      expect((await row(id)).status).toBe('queued');
    } finally {
      await manager.close();
    }
  });
});
