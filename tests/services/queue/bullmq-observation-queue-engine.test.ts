import { afterEach, describe, expect, test } from 'bun:test';
import { Redis } from 'ioredis';
import {
  BullMqObservationQueueEngine,
  getSafeJobId,
  type BullMqObservationQueueEngineOptions,
} from '../../../src/server/queue/BullMqObservationQueueEngine.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';

class FakeJob {
  state: string = 'waiting';
  failMoveToWait = false;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly data: any,
  ) {}

  async getState(): Promise<string> {
    return this.state;
  }

  async moveToCompleted(): Promise<void> {
    this.state = 'completed';
  }

  async remove(): Promise<void> {
    this.state = 'removed';
  }

  async moveToWait(): Promise<number> {
    if (this.failMoveToWait) {
      throw new Error('moveToWait failed');
    }
    this.state = 'waiting';
    return 0;
  }

  async extendLock(): Promise<number> {
    return 1;
  }
}

class FakeQueue {
  readonly jobs: FakeJob[] = [];
  failObliterate = false;
  closed = false;

  async add(name: string, data: any, opts: { jobId?: string } = {}): Promise<FakeJob> {
    const id = opts.jobId ?? String(this.jobs.length + 1);
    const existing = this.jobs.find(job => job.id === id && job.state !== 'removed');
    if (existing) {
      return existing;
    }
    const job = new FakeJob(id, name, data);
    this.jobs.push(job);
    return job;
  }

  async getJob(jobId: string): Promise<FakeJob | undefined> {
    return this.jobs.find(job => job.id === jobId && job.state !== 'removed');
  }

  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(types.map(type => [type, this.jobs.filter(job => job.state === type).length]));
  }

  async getJobs(types: string[]): Promise<FakeJob[]> {
    return this.jobs.filter(job => types.includes(job.state));
  }

  async obliterate(): Promise<void> {
    if (this.failObliterate) {
      throw new Error('obliterate failed');
    }
    this.jobs.length = 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async claimNext(): Promise<FakeJob | undefined> {
    const job = this.jobs.find(item => item.state === 'waiting');
    if (job) {
      job.state = 'active';
    }
    return job;
  }
}

class FakeRedis {
  status: string = 'wait';
  readonly sets = new Map<string, Set<string>>();
  failSets = false;

  async connect(): Promise<void> {
    this.status = 'ready';
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (this.failSets) {
      throw new Error('sadd failed');
    }
    let set = this.sets.get(key);
    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }
    const before = set.size;
    members.forEach(member => set.add(member));
    return set.size - before;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (this.failSets) {
      throw new Error('srem failed');
    }
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    if (this.failSets) {
      throw new Error('smembers failed');
    }
    return Array.from(this.sets.get(key) ?? []);
  }

  async quit(): Promise<void> {
    this.status = 'end';
  }

  disconnect(): void {
    this.status = 'end';
  }
}

function createEngine(options: Partial<BullMqObservationQueueEngineOptions> & {
  queues?: Map<string, FakeQueue>;
  redis?: FakeRedis;
} = {}) {
  const queues = options.queues ?? new Map<string, FakeQueue>();
  const redis = options.redis ?? new FakeRedis();
  const { queues: _queues, redis: _redis, ...engineOptions } = options;
  const getQueue = (name: string) => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new FakeQueue();
      queues.set(name, queue);
    }
    return queue;
  };
  const engine = new BullMqObservationQueueEngine({
    config: {
      engine: 'bullmq',
      mode: 'external',
      url: null,
      host: '127.0.0.1',
      port: 6379,
      prefix: 'test_prefix',
      connection: {
        host: '127.0.0.1',
        port: 6379,
        lazyConnect: true,
        maxRetriesPerRequest: null,
      },
    },
    lockDurationMs: 60_000,
    pollIntervalMs: 5,
    queueFactory: name => getQueue(name) as any,
    workerFactory: name => ({
      getNextJob: () => getQueue(name).claimNext(),
      close: async () => {},
    }) as any,
    redisFactory: () => redis as any,
    ...engineOptions,
  });
  return { engine, queues, redis };
}

describe('BullMqObservationQueueEngine', () => {
  let engine: BullMqObservationQueueEngine | null = null;

  afterEach(async () => {
    await engine?.close();
    engine = null;
  });

  test('uses safe hashed job ids without colon', () => {
    const observation: PendingMessage = {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool:with:colon',
    };
    const summarize: PendingMessage = {
      type: 'summarize',
      last_assistant_message: 'done',
    };

    const obsId = getSafeJobId('session:1', observation, 123);
    const sumId = getSafeJobId('session:1', summarize, 123);
    const fallbackA = getSafeJobId('session:1', { type: 'observation', tool_name: 'Read' }, 123);
    const fallbackB = getSafeJobId('session:1', { type: 'observation', tool_name: 'Read' }, 124);

    expect(obsId).toStartWith('obs_');
    expect(sumId).toStartWith('sum_');
    expect(obsId).not.toContain(':');
    expect(sumId).not.toContain(':');
    expect(fallbackA).not.toBe(fallbackB);
  });

  test('deduplicates active observation jobs by content session and tool use id', async () => {
    ({ engine } = createEngine());

    const first = await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });
    const duplicate = await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });

    expect(first).toBeGreaterThan(0);
    expect(duplicate).toBe(0);
    expect(await engine.getPendingCount(1)).toBe(1);
  });

  test('replaces terminal jobs before reusing a deterministic BullMQ job id', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });
    const queue = result.queues.get('claude_mem_session_1')!;
    queue.jobs[0].state = 'failed';

    const replacement = await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });

    expect(replacement).toBeGreaterThan(0);
    expect(queue.jobs.map(job => job.state)).toEqual(['removed', 'waiting']);
    expect(await engine.getPendingCount(1)).toBe(1);
  });

  test('yields per-session FIFO messages and confirms exact claimed jobs', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'First',
      toolUseId: 'tool-a',
    });
    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Second',
      toolUseId: 'tool-b',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });

    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.value).toMatchObject({ type: 'observation', tool_name: 'First' });
    expect(second.value).toMatchObject({ type: 'observation', tool_name: 'Second' });
    expect(first.value._persistentId).not.toBe(second.value._persistentId);

    expect(await engine.confirmProcessed(first.value._persistentId)).toBe(1);
    expect(await engine.getPendingCount(1)).toBe(1);
    expect(await engine.confirmProcessed(second.value._persistentId)).toBe(1);
    expect(await engine.getPendingCount(1)).toBe(0);
    expect(await result.redis.smembers('test_prefix:queue_registry:sessions')).toEqual([]);

    controller.abort();
    await iterator.return?.();
  });

  test('resetProcessingToPending returns claimed jobs to the session queue', async () => {
    ({ engine } = createEngine());

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });
    const first = await iterator.next();

    expect(first.value.tool_name).toBe('Read');
    expect(await engine.resetProcessingToPending(1)).toBe(1);

    const second = await iterator.next();
    expect(second.value.tool_name).toBe('Read');

    controller.abort();
    await iterator.return?.();
  });

  test('resetProcessingToPending attempts every active claim before throwing', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });
    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Write',
      toolUseId: 'tool-b',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });
    await iterator.next();
    await iterator.next();

    const queue = result.queues.get('claude_mem_session_1')!;
    const failedJob = queue.jobs[0];
    const releasedJob = queue.jobs[1];
    failedJob.failMoveToWait = true;

    await expect(engine.resetProcessingToPending(1)).rejects.toThrow('moveToWait failed');

    expect(failedJob.state).toBe('active');
    expect(releasedJob.state).toBe('waiting');

    failedJob.failMoveToWait = false;
    expect(await engine.resetProcessingToPending(1)).toBe(1);

    controller.abort();
    await iterator.return?.();
  });

  test('close moves local active claims back to wait before dropping state', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });

    const first = await iterator.next();
    expect(first.value.tool_name).toBe('Read');
    expect(result.queues.get('claude_mem_session_1')!.jobs[0].state).toBe('active');

    await engine.close();
    engine = null;

    expect(result.queues.get('claude_mem_session_1')!.jobs[0].state).toBe('waiting');

    controller.abort();
    await iterator.return?.();
  });

  test('close releases local resources when moving a job back to wait fails', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });
    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Write',
      toolUseId: 'tool-b',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });
    await iterator.next();
    await iterator.next();

    const queue = result.queues.get('claude_mem_session_1')!;
    const failedJob = queue.jobs[0];
    const releasedJob = queue.jobs[1];
    failedJob.failMoveToWait = true;
    await expect(engine.close()).rejects.toThrow('moveToWait failed');
    engine = null;

    expect(failedJob.state).toBe('active');
    expect(releasedJob.state).toBe('waiting');
    expect(queue.closed).toBe(true);
    expect(result.redis.status).toBe('end');

    controller.abort();
    await iterator.return?.();
  });

  test('clearPendingForSession preserves active claims when Redis deletion fails', async () => {
    const result = createEngine();
    engine = result.engine;

    await engine.enqueue(1, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 1,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });
    await iterator.next();

    const queue = result.queues.get('claude_mem_session_1')!;
    queue.failObliterate = true;
    await expect(engine.clearPendingForSession(1)).rejects.toThrow('obliterate failed');

    queue.failObliterate = false;
    expect(await engine.resetProcessingToPending(1)).toBe(1);
    expect(queue.jobs[0].state).toBe('waiting');

    controller.abort();
    await iterator.return?.();
  });

  test('discovers queue depth from Redis registry after process restart', async () => {
    const queues = new Map<string, FakeQueue>();
    const redis = new FakeRedis();
    const firstProcess = createEngine({ queues, redis });
    engine = firstProcess.engine;

    await engine.enqueue(7, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    expect(await redis.smembers('test_prefix:queue_registry:sessions')).toEqual(['7']);

    await engine.close();
    const secondProcess = createEngine({ queues, redis });
    engine = secondProcess.engine;

    expect(await engine.getTotalQueueDepth()).toBe(1);
    expect(secondProcess.queues.get('claude_mem_session_7')).toBeDefined();
  });

  test('clearPendingForSession prunes empty sessions from the Redis registry', async () => {
    const queues = new Map<string, FakeQueue>();
    const redis = new FakeRedis();
    const firstProcess = createEngine({ queues, redis });
    engine = firstProcess.engine;

    await engine.enqueue(7, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    expect(await redis.smembers('test_prefix:queue_registry:sessions')).toEqual(['7']);
    expect(await engine.clearPendingForSession(7)).toBe(1);
    expect(await redis.smembers('test_prefix:queue_registry:sessions')).toEqual([]);
  });

  test('reports Redis health without creating sqlite fallback', async () => {
    ({ engine } = createEngine());

    const health = await engine.getHealth();

    expect(health.engine).toBe('bullmq');
    expect(health.redis.status).toBe('ok');
    expect(health.redis.prefix).toBe('test_prefix');
  });

  test('assertHealthy fails instead of falling back when Redis is unavailable', async () => {
    ({ engine } = createEngine({
      redisFactory: () => ({
        status: 'wait',
        connect: async () => {},
        ping: async () => {
          throw new Error('connection refused');
        },
        sadd: async () => 0,
        srem: async () => 0,
        smembers: async () => [],
        quit: async () => {},
        disconnect: () => {},
      }),
    }));

    await expect(engine.assertHealthy()).rejects.toThrow('CLAUDE_MEM_QUEUE_ENGINE=bullmq requires Redis/Valkey');
  });

  const redisIntegrationTest = process.env.CLAUDE_MEM_RUN_REDIS_QUEUE_TESTS === 'true'
    ? test
    : test.skip;

  redisIntegrationTest('releases active jobs and discovers registry with real Redis', async () => {
    const redisUrl = process.env.CLAUDE_MEM_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const prefix = `cm_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const parsedRedisUrl = new URL(redisUrl);
    const redisConnection = {
      host: parsedRedisUrl.hostname || '127.0.0.1',
      port: parsedRedisUrl.port ? Number.parseInt(parsedRedisUrl.port, 10) : 6379,
      username: parsedRedisUrl.username ? decodeURIComponent(parsedRedisUrl.username) : undefined,
      password: parsedRedisUrl.password ? decodeURIComponent(parsedRedisUrl.password) : undefined,
      db: parsedRedisUrl.pathname.length > 1 ? Number.parseInt(parsedRedisUrl.pathname.slice(1), 10) : undefined,
      tls: parsedRedisUrl.protocol === 'rediss:' ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    };
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      connectTimeout: 1000,
    });
    await client.connect();
    await client.ping();
    await client.quit();

    const config = {
      engine: 'bullmq' as const,
      mode: 'external' as const,
      url: redisUrl,
      host: redisConnection.host,
      port: redisConnection.port,
      prefix,
      connection: redisConnection,
    };

    engine = new BullMqObservationQueueEngine({
      config,
      lockDurationMs: 60_000,
      pollIntervalMs: 5,
    });

    await engine.enqueue(99, 'content-session', {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-a',
    });

    const controller = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId: 99,
      signal: controller.signal,
      idleTimeoutMs: 100,
    });
    const first = await iterator.next();
    expect(first.value.tool_name).toBe('Read');
    await engine.close();
    engine = null;

    const restarted = new BullMqObservationQueueEngine({
      config,
      lockDurationMs: 60_000,
      pollIntervalMs: 5,
    });
    engine = restarted;
    expect(await restarted.getTotalQueueDepth()).toBe(1);
    expect(await restarted.clearPendingForSession(99)).toBe(1);

    controller.abort();
    await iterator.return?.();
  });
});
