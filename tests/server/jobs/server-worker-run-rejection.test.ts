import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { ServerJobQueue } from '../../../src/server/jobs/ServerJobQueue.js';

// An unhandled run() rejection can terminate the whole server. Isolate it so
// the regression cannot leave an unhandled rejection in another test's scope.
if (process.env.CLAUDE_MEM_QUEUE_RUN_REJECTION_PROBE === '1') {
  const failure = new Error('blocking Redis connection failed during startup');
  const observed: unknown[] = [];
  let closed = false;
  const queue = new ServerJobQueue({
    name: 'run-rejection',
    config: {
      engine: 'bullmq', mode: 'external', url: '', host: 'unused', port: 6379,
      prefix: 'test', connection: { host: 'unused', lazyConnect: true },
    },
    workerFactory: () => ({
      on() { return this; },
      async run() {
        await setImmediate();
        throw failure;
      },
      async close() { closed = true; },
    }) as any,
  });
  queue.observe({ onError() { throw new Error('broken diagnostic listener'); } });
  queue.observe({ onError(error) { observed.push(error); } });
  queue.start(async () => {});
  await setImmediate();
  await setImmediate();

  assert.deepEqual(observed, [failure]);
  assert.equal(queue.getLifecycleCounters().errored, 1);
  await queue.close();
  assert.equal(closed, true);
  process.stdout.write('worker rejection reported and resources closed\n');
} else {
  it('reports a rejected worker run without terminating the server', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CLAUDE_MEM_QUEUE_RUN_REJECTION_PROBE: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /worker rejection reported and resources closed/);
  });
}
