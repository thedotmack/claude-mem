// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobsOptions } from 'bullmq';
import {
  __clearServerJobsTestSeams,
  __setServerJobsTestSeams,
  runServerJobsCommand,
} from '../../src/npx-cli/commands/server-jobs.js';

const QUEUE_ENV: Record<string, string> = {
  CLAUDE_MEM_QUEUE_ENGINE: 'bullmq',
  CLAUDE_MEM_REDIS_MODE: 'external',
  CLAUDE_MEM_REDIS_URL: '',
  CLAUDE_MEM_REDIS_HOST: '127.0.0.1',
  CLAUDE_MEM_REDIS_PORT: '6379',
  CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://test/test',
};

// Runs `server jobs retry` on a failed job with Postgres stubbed and the
// BullMQ Queue replaced, and returns what reached the queue.
async function retryFailedJob(sourceType: string) {
  const previousEnv = new Map(Object.keys(QUEUE_ENV).map(key => [key, process.env[key]]));
  Object.assign(process.env, QUEUE_ENV);
  const originalLog = console.log;
  console.log = () => {};
  const queues: string[] = [];
  const removed: string[] = [];
  const added: Array<{ name: string; payload: unknown; opts: JobsOptions | undefined }> = [];
  let closed = 0;
  __setServerJobsTestSeams({
    openPool: async () => ({
      pool: { query: async (sql: string) => {
        if (sql.includes('SELECT id, team_id')) return { rows: [{
          id: 'job-1', team_id: 'team-1', project_id: 'project-1', status: 'failed',
          attempts: 1, bullmq_job_id: 'event-1', source_type: sourceType, payload: { kind: 'event' },
        }] };
        return { rows: sql.includes('UPDATE') ? [{
          id: 'job-1', status: 'queued', attempts: 1,
          bullmq_job_id: 'event-1', source_type: sourceType,
        }] : [] };
      } },
      releasePool: async () => {},
    }),
    bullmqQueueFactory: name => {
      queues.push(name);
      return {
        add: async (jobName: string, payload: unknown, opts?: JobsOptions) => {
          added.push({ name: jobName, payload, opts });
          return { id: opts?.jobId } as never;
        },
        getJob: async () => undefined,
        getJobCounts: async () => ({}),
        remove: async (jobId: string) => { removed.push(jobId); return 1; },
        close: async () => { closed++; },
      };
    },
  });
  try {
    await runServerJobsCommand(['retry', 'job-1', '--team', 'team-1']);
  } finally {
    __clearServerJobsTestSeams();
    console.log = originalLog;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { queues, removed, added, closed };
}

test('retry republishes with the attempts and backoff the server queue gives its jobs', async () => {
  const result = await retryFailedJob('agent_event');

  assert.deepEqual(result.queues, ['server_beta_generate_event']);
  assert.deepEqual(result.removed, ['event-1']);
  assert.equal(result.added.length, 1);
  const { name, payload, opts } = result.added[0]!;
  assert.equal(name, 'server_beta_generate_event');
  assert.equal(opts?.jobId, 'event-1');
  assert.equal((payload as { kind?: string }).kind, 'event');
  // A bare Queue.add() defaults to zero attempts: BullMQ then drops the job
  // on the first retryable provider error while its outbox row stays queued.
  assert.equal(opts?.attempts, 3);
  assert.deepEqual(opts?.backoff, { type: 'exponential', delay: 5000 });
  assert.equal(result.closed, 1);
});

test('retry republishes a session summary job on the summary lane', async () => {
  const result = await retryFailedJob('session_summary');

  assert.deepEqual(result.queues, ['server_beta_generate_summary']);
  assert.equal(result.added[0]?.opts?.attempts, 3);
});
