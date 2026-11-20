import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ServerService } from '../../src/server/runtime/ServerService.js';
import type { ServerServiceGraph } from '../../src/server/runtime/types.js';

function serviceWith(closers: {
  queue: () => Promise<void>;
  generation: () => Promise<void>;
  background: () => Promise<void>;
  pool: () => Promise<void>;
}): ServerService {
  return new ServerService({
    persistRuntimeState: false, port: 0,
    graph: {
      runtime: 'server-beta', authMode: 'api-key',
      postgres: { pool: { end: closers.pool }, bootstrap: { initialized: true, schemaVersion: 1, appliedAt: null } },
      queueManager: { close: closers.queue }, generationWorkerManager: { close: closers.generation },
      stopBackgroundWork: closers.background,
    } as unknown as ServerServiceGraph,
  });
}

describe('server shutdown after HTTP closes', () => {
  it('waits for every background owner and closes the pool when one boundary rejects', async () => {
    const failure = new Error('queue close failed');
    const closed: string[] = [];
    let releaseBackground!: () => void;
    const background = new Promise<void>(resolve => { releaseBackground = resolve; });
    const service = serviceWith({
      queue: async () => { closed.push('queue'); throw failure; },
      generation: async () => { closed.push('generation'); },
      background: async () => { await background; closed.push('background'); },
      pool: async () => { closed.push('pool'); },
    });
    let settled = false;
    const stopping = service.stop().then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; },
    );
    await setImmediate();
    const finishedBeforeBackground = settled;
    releaseBackground();
    const result = await stopping;

    assert.equal(finishedBeforeBackground, false, 'stop must retain ownership until all closers settle');
    assert.equal(result, failure);
    assert.deepEqual(closed, ['queue', 'generation', 'background', 'pool']);
  });

  it('runs the remaining closers after a synchronous boundary failure', async () => {
    const failure = new Error('synchronous close failure');
    const closed: string[] = [];
    const service = serviceWith({
      queue: () => { throw failure; },
      generation: async () => { closed.push('generation'); },
      background: async () => { closed.push('background'); },
      pool: async () => { closed.push('pool'); },
    });
    await assert.rejects(service.stop(), error => error === failure);
    assert.deepEqual(closed, ['generation', 'background', 'pool']);
  });

  it('preserves a pool close failure after otherwise successful cleanup', async () => {
    const failure = new Error('pool close failed');
    const closed: string[] = [];
    const service = serviceWith({
      queue: async () => { closed.push('queue'); },
      generation: async () => { closed.push('generation'); },
      background: async () => { closed.push('background'); },
      pool: async () => { closed.push('pool'); throw failure; },
    });
    await assert.rejects(service.stop(), error => error === failure);
    assert.deepEqual(closed, ['queue', 'generation', 'background', 'pool']);
  });
});
