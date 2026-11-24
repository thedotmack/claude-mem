// SPDX-License-Identifier: Apache-2.0

import { expect, it } from 'bun:test';
import type { Job, Processor } from 'bullmq';
import { ActiveServerGenerationWorkerManager } from '../../../src/server/runtime/ActiveServerGenerationWorkerManager.js';
import type { ServerGenerationJobPayload } from '../../../src/server/jobs/types.js';

// The generator moves a rate-limited job to delayed, and BullMQ refuses that
// move without the lock token of the delivery being processed.
it('hands each delivery\'s lock token to the generator', async () => {
  const processors: Processor<ServerGenerationJobPayload>[] = [];
  const lane = { observe: () => {}, getLockDurationMs: () => 5 * 60 * 1000 };
  const seen: Array<string | undefined> = [];
  const manager = new ActiveServerGenerationWorkerManager({
    // The stale-lock sweep at start finds nothing.
    pool: { query: async () => ({ rows: [] }) } as never,
    queueManager: {
      start: (_kind: string, processor: Processor<ServerGenerationJobPayload>) => { processors.push(processor); },
      getQueue: () => lane,
    } as never,
    provider: {} as never,
    generatorFactory: () => ({
      process: async (_job: Job<ServerGenerationJobPayload>, token?: string) => {
        seen.push(token);
        return { jobId: 'job-1', status: 'completed' as const, observationCount: 0 };
      },
    }) as never,
  });

  manager.start();
  try {
    const job = { id: 'bull-1', data: { kind: 'event' } } as Job<ServerGenerationJobPayload>;
    for (const processor of processors) await processor(job, 'worker-token');
  } finally {
    await manager.close();
  }

  expect(processors.length).toBe(2);
  expect(seen).toEqual(['worker-token', 'worker-token']);
});
