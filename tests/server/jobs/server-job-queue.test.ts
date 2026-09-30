import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Job, Processor, QueueOptions, WorkerOptions } from 'bullmq';
import { ServerJobQueue } from '../../../src/server/jobs/ServerJobQueue.js';
import type { RedisQueueConfig } from '../../../src/server/queue/redis-config.js';

const fakeConfig: RedisQueueConfig = {
  engine: 'bullmq',
  mode: 'managed',
  url: 'redis://test/0',
  host: 'test',
  port: 6379,
  prefix: 'cmem-test',
  connection: { host: 'test', port: 6379, lazyConnect: true }
};

interface FakeQueueState {
  added: Array<{ name: string; payload: unknown; jobId?: string }>;
  removed: string[];
  closed: boolean;
}

interface FakeWorkerState {
  processor: Processor<unknown> | null;
  options: WorkerOptions | null;
  errorHandlers: Array<(error: unknown) => void>;
  ranWith: 'autorun-false' | 'autorun-true' | null;
  closed: boolean;
  eventHandlers?: Map<string, (...args: unknown[]) => void>;
}

function buildFakeQueue(state: FakeQueueState) {
  return (_name: string, _options: QueueOptions) => ({
    add: async (name: string, payload: unknown, opts?: { jobId?: string }) => {
      state.added.push({ name, payload, jobId: opts?.jobId });
      return { id: opts?.jobId ?? 'job_anon' } as Job<unknown>;
    },
    getJob: async (_id: string) => null,
    getJobCounts: async (..._states: string[]) => ({
      waiting: 1,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0
    }),
    remove: async (id: string) => {
      state.removed.push(id);
    },
    close: async () => {
      state.closed = true;
    }
  });
}

function buildFakeWorker(state: FakeWorkerState) {
  return (_name: string, processor: Processor<unknown> | null, options: WorkerOptions) => {
    state.processor = processor;
    state.options = options;
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'error') {
          state.errorHandlers.push(handler as (error: unknown) => void);
        }
        // Phase 12 — capture all lifecycle handlers on the fake worker so
        // tests can fire completed/failed/stalled events synchronously.
        const ev = state.eventHandlers ?? (state.eventHandlers = new Map());
        ev.set(event, handler);
      },
      run: () => {
        state.ranWith = options.autorun === false ? 'autorun-false' : 'autorun-true';
      },
      close: async () => {
        state.closed = true;
      }
    };
  };
}

describe('ServerJobQueue', () => {
  afterEach(() => {
    mock.restore();
  });

  it('rejects jobIds that contain colons (BullMQ key separator)', async () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState)
    });
    await expect(sjq.add('bad:id', { x: 1 })).rejects.toThrow(/must not contain ':'/);
    expect(queueState.added.length).toBe(0);
    await sjq.close();
  });

  it('passes the jobId through to BullMQ Queue.add', async () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState)
    });
    await sjq.add('evt_abc', { x: 1 });
    expect(queueState.added).toHaveLength(1);
    expect(queueState.added[0]!.jobId).toBe('evt_abc');
    expect(queueState.added[0]!.payload).toEqual({ x: 1 });
    await sjq.close();
  });

  it('starts the worker with autorun: false and attaches an error listener', () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const workerState: FakeWorkerState = {
      processor: null,
      options: null,
      errorHandlers: [],
      ranWith: null,
      closed: false
    };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState),
      workerFactory: buildFakeWorker(workerState)
    });
    sjq.start(async () => {});

    expect(workerState.options?.autorun).toBe(false);
    expect(workerState.options?.concurrency).toBe(1);
    expect(workerState.errorHandlers.length).toBeGreaterThanOrEqual(1);
    expect(workerState.ranWith).toBe('autorun-false');
    expect(sjq.isStarted()).toBe(true);
  });

  it('refuses double-start to avoid duplicate Worker instances', () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const workerState: FakeWorkerState = {
      processor: null,
      options: null,
      errorHandlers: [],
      ranWith: null,
      closed: false
    };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState),
      workerFactory: buildFakeWorker(workerState)
    });
    sjq.start(async () => {});
    expect(() => sjq.start(async () => {})).toThrow(/already started/);
  });

  it('error listener absorbs worker errors without throwing', () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const workerState: FakeWorkerState = {
      processor: null,
      options: null,
      errorHandlers: [],
      ranWith: null,
      closed: false
    };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState),
      workerFactory: buildFakeWorker(workerState)
    });
    sjq.start(async () => {});
    expect(() =>
      workerState.errorHandlers[0]!(new Error('worker crashed'))
    ).not.toThrow();
  });

  it('Phase 12 — emits completed/failed/stalled lifecycle events through observe()', () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const workerState: FakeWorkerState = {
      processor: null, options: null, errorHandlers: [], ranWith: null, closed: false,
    };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q', config: fakeConfig,
      queueFactory: buildFakeQueue(queueState),
      workerFactory: buildFakeWorker(workerState),
    });

    const events: { kind: string; jobId?: string; arg?: unknown }[] = [];
    sjq.observe({
      onCompleted: (jobId, durationMs) => { events.push({ kind: 'completed', jobId, arg: durationMs }); },
      onFailed: (jobId, attempts, reason) => { events.push({ kind: 'failed', jobId: jobId ?? '?', arg: { attempts, reason } }); },
      onStalled: (jobId) => { events.push({ kind: 'stalled', jobId }); },
      onError: (err) => { events.push({ kind: 'error', arg: err }); },
    });
    sjq.start(async () => {});

    // Fire a fake "active" then "completed" so duration is positive.
    workerState.eventHandlers?.get('active')?.({ id: 'job1' });
    workerState.eventHandlers?.get('completed')?.({ id: 'job1', data: { source_type: 'agent_event' } }, { ok: true });
    workerState.eventHandlers?.get('failed')?.({ id: 'job2', data: { source_type: 'agent_event' }, attemptsMade: 2 }, new Error('boom'));
    workerState.eventHandlers?.get('stalled')?.('job3');
    workerState.errorHandlers[0]!(new Error('worker err'));

    expect(events.find(e => e.kind === 'completed')?.jobId).toBe('job1');
    expect(events.find(e => e.kind === 'failed')?.jobId).toBe('job2');
    expect(events.find(e => e.kind === 'stalled')?.jobId).toBe('job3');
    expect(events.some(e => e.kind === 'error')).toBe(true);

    const counters = sjq.getLifecycleCounters();
    expect(counters.stalled).toBe(1);
    expect(counters.errored).toBe(1);
  });

  it('closes worker and queue on close()', async () => {
    const queueState: FakeQueueState = { added: [], removed: [], closed: false };
    const workerState: FakeWorkerState = {
      processor: null,
      options: null,
      errorHandlers: [],
      ranWith: null,
      closed: false
    };
    const sjq = new ServerJobQueue<{ x: number }>({
      name: 'q',
      config: fakeConfig,
      queueFactory: buildFakeQueue(queueState),
      workerFactory: buildFakeWorker(workerState)
    });
    sjq.start(async () => {});
    await sjq.add('evt_test', { x: 1 });
    await sjq.close();
    expect(workerState.closed).toBe(true);
    expect(queueState.closed).toBe(true);
    expect(sjq.isStarted()).toBe(false);
  });
});
