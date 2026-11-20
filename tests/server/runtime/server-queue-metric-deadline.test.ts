import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ActiveServerQueueManager } from '../../../src/server/runtime/ActiveServerQueueManager.js';
import type { ServerJobQueue, ServerJobCounts } from '../../../src/server/jobs/ServerJobQueue.js';
import type { ServerGenerationJobKind, ServerGenerationJobPayload } from '../../../src/server/jobs/types.js';

const counts: ServerJobCounts = { waiting: 7, active: 1, completed: 2, failed: 0, delayed: 0 };
const config = {
  engine: 'bullmq' as const, mode: 'external' as const, url: null,
  host: 'unused', port: 6379, prefix: 'test',
  connection: { host: 'unused', lazyConnect: true, maxRetriesPerRequest: null },
};

function managerWith(event: () => Promise<ServerJobCounts>, summary = async () => counts) {
  const queues = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>();
  for (const [kind, getCounts] of [['event', event], ['summary', summary]] as const) {
    queues.set(kind, {
      getCounts, getLifecycleCounters: () => ({ stalled: 3, errored: 0 }), close: async () => {},
    } as unknown as ServerJobQueue<ServerGenerationJobPayload>);
  }
  return new ActiveServerQueueManager(config, queues, 10);
}

async function promptly<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('queue diagnostics did not settle')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('bounded queue diagnostics', () => {
  it('reports an unresponsive lane while returning the healthy lane', async () => {
    const manager = managerWith(() => new Promise(() => {}));
    const metrics = await promptly(manager.getLaneMetrics());

    assert.equal(metrics.length, 2);
    assert.equal(metrics[0].kind, 'event');
    assert.equal(metrics[0].unavailable, true);
    assert.equal(metrics[0].stalled, 3);
    assert.match(metrics[0].unavailableReason!, /timed out/);
    assert.equal(metrics[1].kind, 'summary');
    assert.equal(metrics[1].unavailable, false);
    assert.equal(metrics[1].waiting, 7);
    await manager.close();
  });

  it('shares a pending read across polls and probes again after Redis responds', async () => {
    let calls = 0;
    let resolvePending!: (value: ServerJobCounts) => void;
    const pending = new Promise<ServerJobCounts>(resolve => { resolvePending = resolve; });
    let thenRegistrations = 0;
    const originalThen = pending.then.bind(pending);
    pending.then = ((...args: Parameters<typeof pending.then>) => {
      thenRegistrations++;
      return originalThen(...args);
    }) as typeof pending.then;
    const manager = managerWith(() => ++calls === 1 ? pending : Promise.resolve(counts));

    // Check both concurrent callers before the diagnostic deadline and later
    // polls after it. Sharing getCounts alone would still leak callbacks if
    // every poll created its own race against the never-settling Redis read.
    const initial = manager.getLaneMetrics();
    const initialRegistrations = thenRegistrations;
    assert.ok(initialRegistrations > 0, 'the underlying read should have a settlement observer');
    const first = await promptly(Promise.all([
      initial, manager.getLaneMetrics(), manager.getLaneMetrics(),
    ]));
    assert.equal(first.every(metrics => metrics[0].unavailable), true);
    assert.equal(calls, 1, 'concurrent status requests must not multiply queued Redis commands');
    assert.equal(thenRegistrations, initialRegistrations, 'concurrent polls must share the pending observer');
    for (let poll = 0; poll < 20; poll++) await promptly(manager.getLaneMetrics());
    assert.equal(calls, 1, 'a timed-out command remains shared until it really settles');
    assert.equal(thenRegistrations, initialRegistrations, 'timed-out polls must not accumulate callbacks on the stuck read');

    resolvePending(counts);
    await setImmediate();
    const recovered = await promptly(manager.getLaneMetrics());
    assert.equal(calls, 2);
    assert.equal(recovered[0].unavailable, false);
    assert.equal(recovered[0].waiting, 7);
    await manager.close();
  });

  it('clears failed reads so a later status can recover', async () => {
    let calls = 0;
    const manager = managerWith(async () => {
      if (++calls === 1) throw new Error('Redis unavailable');
      return counts;
    });
    assert.equal((await manager.getLaneMetrics())[0].unavailable, true);
    assert.equal((await manager.getLaneMetrics())[0].unavailable, false);
    assert.equal(calls, 2);
    await manager.close();
  });
});
