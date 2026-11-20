import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __clearServerJobsTestSeams,
  __setServerJobsTestSeams,
  runServerJobsCommand,
} from '../../src/npx-cli/commands/server-jobs.js';

async function retryFrom(status: string) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalUrl = process.env.CLAUDE_MEM_SERVER_DATABASE_URL;
  const writes: string[] = [];
  const errors: string[] = [];
  let published = 0;
  let released = false;
  let rejection: unknown;
  process.env.CLAUDE_MEM_SERVER_DATABASE_URL = 'postgres://test/test';
  process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as never;
  console.log = () => {};
  console.error = message => { errors.push(String(message)); };
  __setServerJobsTestSeams({
    openPool: async () => ({
      pool: { query: async (sql: string) => {
        if (sql.includes('SELECT id, team_id')) return { rows: [{
          id: 'job-1', team_id: 'team-1', project_id: 'project-1', status,
          attempts: 1, bullmq_job_id: 'event-1', source_type: 'agent_event', payload: {},
        }] };
        writes.push(sql);
        return { rows: sql.includes('UPDATE') ? [{
          id: 'job-1', status: 'queued', attempts: 1,
          bullmq_job_id: 'event-1', source_type: 'agent_event',
        }] : [] };
      } },
      releasePool: async () => { released = true; },
    }),
    republishToBullmq: async () => { published++; },
  });
  try {
    await runServerJobsCommand(['retry', 'job-1', '--team', 'team-1']);
  } catch (error) {
    rejection = error;
  } finally {
    __clearServerJobsTestSeams();
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    if (originalUrl === undefined) delete process.env.CLAUDE_MEM_SERVER_DATABASE_URL;
    else process.env.CLAUDE_MEM_SERVER_DATABASE_URL = originalUrl;
  }
  return { writes, errors, published, released, rejection };
}

test('retry preserves completed generation jobs without writes or republication', async () => {
  const result = await retryFrom('completed');
  assert.ok(result.rejection instanceof Error);
  assert.match(result.errors.join('\n'), /completed/);
  assert.deepEqual(result.writes, []);
  assert.equal(result.published, 0);
  assert.equal(result.released, true);
});

test('retry refuses unknown states instead of implicitly reopening them', async () => {
  const result = await retryFrom('future-terminal-state');
  assert.ok(result.rejection instanceof Error);
  assert.deepEqual(result.writes, []);
  assert.equal(result.published, 0);
});

for (const status of ['failed', 'cancelled']) {
  test(`retry still requeues an explicitly retryable ${status} job`, async () => {
    const result = await retryFrom(status);
    assert.equal(result.rejection, undefined);
    assert.equal(result.writes.filter(sql => sql.includes('UPDATE')).length, 1);
    assert.equal(result.published, 1);
    assert.equal(result.released, true);
  });
}

test('retry keeps queued jobs idempotent', async () => {
  const result = await retryFrom('queued');
  assert.equal(result.rejection, undefined);
  assert.equal(result.writes.filter(sql => sql.includes('UPDATE')).length, 0);
  assert.equal(result.published, 0);
});
