// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { logger } from '../../src/utils/logger.js';
import {
  __clearServerJobsTestSeams,
  __setServerJobsTestSeams,
  runServerJobsCommand,
} from '../../src/npx-cli/commands/server-jobs.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../sdk/pg-isolation.js';

// Phase 12 — `claude-mem server jobs` operator console. Uses the
// __setServerJobsTestSeams test seam (preferred over mock.module which leaks
// across Bun test files). Each test wires its own pool + bullmq fakes.

interface MockQueryCall { sql: string; params: unknown[] }
interface MockPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

function buildMockPool(rowsFor: (sql: string, params: unknown[]) => unknown[]): { pool: MockPool; calls: MockQueryCall[] } {
  const calls: MockQueryCall[] = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: rowsFor(sql, params) };
      },
    },
  };
}

describe('Phase 12 — server jobs CLI', () => {
  const originalEnv = { ...process.env };
  let logSpies: ReturnType<typeof spyOn>[] = [];
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let exitCalls: number[] = [];

  beforeEach(() => {
    logSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = spyOn(console, 'error').mockImplementation(() => {});
    exitCalls = [];
    exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never;

    process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgres://test/test';
    process.env.CLAUDE_MEM_SERVER_ADMIN = '1';
  });

  afterEach(() => {
    __clearServerJobsTestSeams();
    logSpies.forEach(s => s.mockRestore());
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
    process.env = { ...originalEnv };
    mock.restore();
  });

  it('refuses unscoped operations without admin override', async () => {
    delete process.env.CLAUDE_MEM_SERVER_ADMIN;
    await expect(runServerJobsCommand(['status'])).rejects.toThrow(/__exit_1__/);
    expect(exitCalls).toContain(1);
    const errMsg = consoleErrSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(errMsg).toMatch(/Refusing to run unscoped/);
  });

  it('status divergence: surfaces postgres counts when bullmq is unavailable', async () => {
    const mockData = buildMockPool((sql: string) => {
      if (sql.includes('GROUP BY status')) {
        return [{ status: 'queued', count: 3 }, { status: 'failed', count: 1 }];
      }
      return [];
    });
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: mockData.pool as never, releasePool: async () => {} }),
      collectBullmqCounts: async () => { throw new Error('bullmq unavailable'); },
    });
    await runServerJobsCommand(['status', '--team', 'team-1']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"queued": 3/);
    expect(printed).toMatch(/"failed": 1/);
    expect(printed).toMatch(/"unavailable": true/);
  });

  it('status: detects divergence between postgres and bullmq counts', async () => {
    const mockData = buildMockPool((sql: string) => {
      if (sql.includes('GROUP BY status')) {
        return [{ status: 'queued', count: 5 }, { status: 'failed', count: 2 }];
      }
      return [];
    });
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: mockData.pool as never, releasePool: async () => {} }),
      collectBullmqCounts: async () => ({
        event: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, stalled: 0 },
        summary: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, stalled: 0 },
      }),
    });
    await runServerJobsCommand(['status']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"queuedMismatch"/);
    expect(printed).toMatch(/"postgres": 5/);
    expect(printed).toMatch(/"bullmq": 1/);
    expect(printed).toMatch(/"failedMismatch"/);

    // A single project's Postgres rows cannot be compared with every Redis lane.
    consoleLogSpy.mockClear();
    await runServerJobsCommand(['status', '--project', 'p-1']);
    const scoped = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(scoped.postgres.queued).toBe(5);
    expect(scoped.divergence).toEqual({ reason: 'queue_counts_are_global' });
  });

  it('failed: lists failed jobs with last_error.message extracted', async () => {
    const mockData = buildMockPool((sql: string) => {
      if (sql.includes('status = \'failed\'')) {
        return [{
          id: 'gj_1',
          source_type: 'agent_event',
          source_id: 'ev_1',
          attempts: 3,
          failed_at: new Date('2026-05-08T12:00:00Z'),
          last_error: { message: 'provider timeout' },
          team_id: 'team-1',
          project_id: 'p-1',
        }];
      }
      return [];
    });
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: mockData.pool as never, releasePool: async () => {} }),
      collectBullmqCounts: async () => { throw new Error('not configured'); },
    });
    await runServerJobsCommand(['failed', '--team', 'team-1']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"id": "gj_1"/);
    expect(printed).toMatch(/"lastError": "provider timeout"/);
    expect(printed).toMatch(/"attempts": 3/);
  });

  it('retry: idempotent on already-queued jobs (no UPDATE issued)', async () => {
    const mockData = buildMockPool((sql: string) => {
      if (sql.includes('SELECT id, team_id, project_id, status')) {
        return [{
          id: 'gj_1',
          team_id: 'team-1',
          project_id: 'p-1',
          status: 'queued',
          attempts: 0,
          bullmq_job_id: 'evt_abc',
          source_type: 'agent_event',
          payload: { retried_count: 0 },
        }];
      }
      return [];
    });
    let republishCalled = false;
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: mockData.pool as never, releasePool: async () => {} }),
      republishToBullmq: async () => { republishCalled = true; },
    });
    await runServerJobsCommand(['retry', 'gj_1', '--team', 'team-1']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"outcome": "noop_already_queued"/);
    // Idempotent: no UPDATE/republish.
    const updates = mockData.calls.filter(c => /^\s*UPDATE/m.test(c.sql));
    expect(updates.length).toBe(0);
    expect(republishCalled).toBe(false);
  });

  it('retry: re-enqueues a failed job and increments retried_count', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool: MockPool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id, team_id, project_id, status')) {
          return { rows: [{
            id: 'gj_failed',
            team_id: 'team-1',
            project_id: 'p-1',
            status: 'failed',
            attempts: 2,
            bullmq_job_id: 'evt_abc',
            source_type: 'agent_event',
            payload: { retried_count: 1 },
          }] };
        }
        if (sql.includes('UPDATE observation_generation_jobs')) {
          return { rows: [{
            id: 'gj_failed', status: 'queued', attempts: 2,
            bullmq_job_id: 'evt_abc', source_type: 'agent_event',
          }] };
        }
        return { rows: [] };
      },
    };
    let republishCalled = false;
    let republishedPayload: Record<string, unknown> = {};
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: pool as never, releasePool: async () => {} }),
      republishToBullmq: async (_st, _id, payload) => {
        republishCalled = true;
        republishedPayload = payload;
      },
    });
    await runServerJobsCommand(['retry', 'gj_failed', '--team', 'team-1']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"outcome": "requeued"/);
    expect(printed).toMatch(/"retriedCount": 2/);
    expect(republishCalled).toBe(true);
    expect(republishedPayload.retried_count).toBe(2);
    // Lifecycle event row + audit row both inserted.
    const inserts = calls.filter(c => /INSERT INTO/i.test(c.sql));
    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });

  it('cancel: refuses to cancel a completed job', async () => {
    const mockData = buildMockPool((sql: string) => {
      if (sql.includes('SELECT id, team_id, project_id, status')) {
        return [{
          id: 'gj_done',
          team_id: 'team-1',
          project_id: 'p-1',
          status: 'completed',
          attempts: 1,
          bullmq_job_id: null,
          source_type: 'agent_event',
          payload: {},
        }];
      }
      return [];
    });
    __setServerJobsTestSeams({
      openPool: async () => ({ pool: mockData.pool as never, releasePool: async () => {} }),
    });
    await expect(runServerJobsCommand(['cancel', 'gj_done', '--team', 'team-1'])).rejects.toThrow(/__exit_1__/);
    const errMsg = consoleErrSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(errMsg).toMatch(/Cannot cancel a completed job/);
  });
});

// The commands read the job's status, then write. These tests let another
// writer commit between the two, against real Postgres.
describe('server jobs CLI — state changed after the status check', () => {
  const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }
  const originalEnv = { ...process.env };
  let spies: ReturnType<typeof spyOn>[] = [];
  let pool: pg.Pool;
  let storage: PostgresStorageRepositories;
  let schema: string;
  let teamId: string;
  let projectId: string;
  let jobId: string;
  let published: string[];
  let removed: string[];
  let afterStatusCheck: (() => Promise<unknown>) | null;

  beforeEach(async () => {
    schema = await createIsolatedSchema(databaseUrl, 'cm_cli_jobs');
    pool = poolForSchema(databaseUrl, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'cli-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'cli-project' });
    teamId = team.id; projectId = project.id;
    const event = await storage.agentEvents.create({ projectId, teamId, sourceAdapter: 'api', eventType: 'tool_use', payload: {}, occurredAt: new Date() });
    jobId = randomUUID();
    await storage.observationGenerationJobs.create({
      id: jobId, projectId, teamId, sourceType: 'agent_event', sourceId: event.id, agentEventId: event.id,
      jobType: 'observation_generate_for_event', bullmqJobId: `event-${event.id}`,
      payload: { kind: 'event', team_id: teamId, project_id: projectId, source_type: 'agent_event', source_id: event.id, generation_job_id: jobId },
    });
    published = []; removed = []; afterStatusCheck = null;
    spies = [
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
      spyOn(process, 'exit').mockImplementation((code?: number) => { throw new Error(`__exit_${code ?? 0}__`); }) as never,
    ];
    process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgres://seamed/pool';
    __setServerJobsTestSeams({
      openPool: async () => ({
        pool: {
          query: async (sql: string, params: unknown[]) => {
            const result = await pool.query(sql, params);
            if (afterStatusCheck && sql.includes('SELECT id, team_id, project_id, status')) {
              const otherWriter = afterStatusCheck;
              afterStatusCheck = null;
              await otherWriter();
            }
            return result;
          },
        },
        releasePool: async () => {},
      }),
      republishToBullmq: async (_sourceType, id) => { published.push(id); },
      removeFromBullmq: async (_sourceType, id) => { removed.push(id); },
    });
  });

  afterEach(async () => {
    __clearServerJobsTestSeams();
    spies.forEach(spy => spy.mockRestore());
    process.env = { ...originalEnv };
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); }
  });

  const reload = () => storage.observationGenerationJobs.getByIdForScope({ id: jobId, teamId, projectId });
  const move = (next: 'processing' | 'completed' | 'failed') => storage.observationGenerationJobs.transitionStatus({
    id: jobId, teamId, projectId, status: next, lockedBy: 'fixture-worker',
  });
  async function lifecycleCount(eventType: string): Promise<number> {
    const result = await pool.query('SELECT COUNT(*)::int AS n FROM observation_generation_job_events WHERE generation_job_id = $1 AND event_type = $2', [jobId, eventType]);
    return result.rows[0].n;
  }

  it('cancel does not overwrite a job that completed after the status check', async () => {
    await move('processing');
    afterStatusCheck = () => move('completed');
    await expect(runServerJobsCommand(['cancel', jobId, '--team', teamId])).rejects.toThrow(/__exit_1__/);
    const final = await reload();
    expect(final?.status).toBe('completed');
    expect(final?.cancelledAtEpoch).toBeNull();
    expect(removed).toEqual([]);
    expect(await lifecycleCount('cancelled')).toBe(0);
  });

  for (const winnerState of ['processing', 'completed'] as const) {
    it(`retry does not requeue a job another retry already moved to ${winnerState}`, async () => {
      await move('processing'); await move('failed');
      afterStatusCheck = async () => {
        // POST /v1/jobs/:id/retry from another operator, then a worker picks it up.
        await pool.query(
          `UPDATE observation_generation_jobs
           SET status = 'queued', failed_at = NULL, last_error = NULL, attempts = LEAST(attempts, max_attempts - 1)
           WHERE id = $1`,
          [jobId],
        );
        await move('processing');
        if (winnerState === 'completed') await move('completed');
      };
      await expect(runServerJobsCommand(['retry', jobId, '--team', teamId])).rejects.toThrow(/__exit_1__/);
      const final = await reload();
      expect(final?.status).toBe(winnerState);
      if (winnerState === 'processing') expect(final?.lockedBy).toBe('fixture-worker');
      else expect(final?.completedAtEpoch).not.toBeNull();
      expect(published).toEqual([]);
      expect(await lifecycleCount('queued')).toBe(0);
    });
  }

  it('retry and cancel still write when the job is unchanged', async () => {
    await move('processing'); await move('failed');
    await runServerJobsCommand(['retry', jobId, '--team', teamId]);
    expect((await reload())?.status).toBe('queued');
    expect(published.length).toBe(1);
    await runServerJobsCommand(['cancel', jobId, '--team', teamId]);
    expect((await reload())?.status).toBe('cancelled');
    expect(removed.length).toBe(1);
  });
});
