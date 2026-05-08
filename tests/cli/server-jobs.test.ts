// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import {
  __clearServerJobsTestSeams,
  __setServerJobsTestSeams,
  runServerJobsCommand,
} from '../../src/npx-cli/commands/server-jobs.js';

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
    await runServerJobsCommand(['status', '--team', 'team-1']);
    const printed = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/"queuedMismatch"/);
    expect(printed).toMatch(/"postgres": 5/);
    expect(printed).toMatch(/"bullmq": 1/);
    expect(printed).toMatch(/"failedMismatch"/);
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
