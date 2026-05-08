import { afterEach, describe, expect, it, mock } from 'bun:test';
import { ActiveServerBetaQueueManager } from '../../../src/server/runtime/ActiveServerBetaQueueManager.js';
import { ServerJobQueue } from '../../../src/server/jobs/ServerJobQueue.js';
import type {
  ServerGenerationJobKind,
  ServerGenerationJobPayload,
} from '../../../src/server/jobs/types.js';
import type { RedisQueueConfig } from '../../../src/server/queue/redis-config.js';

const bullmqConfig: RedisQueueConfig = {
  engine: 'bullmq',
  mode: 'managed',
  url: null,
  host: '127.0.0.1',
  port: 6379,
  prefix: 'cmem-test',
  connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
};

const sqliteConfig: RedisQueueConfig = {
  ...bullmqConfig,
  engine: 'sqlite',
};

function buildStubQueues(): {
  queues: Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>;
  closedNames: string[];
} {
  const closedNames: string[] = [];
  const make = (name: string) => ({
    name,
    add: async () => {},
    remove: async () => {},
    getJob: async () => null,
    getCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
    start: () => {},
    isStarted: () => false,
    close: async () => {
      closedNames.push(name);
    },
  }) as unknown as ServerJobQueue<ServerGenerationJobPayload>;

  const queues = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>();
  queues.set('event', make('event'));
  queues.set('event-batch', make('event-batch'));
  queues.set('summary', make('summary'));
  queues.set('reindex', make('reindex'));
  return { queues, closedNames };
}

describe('ActiveServerBetaQueueManager', () => {
  afterEach(() => {
    mock.restore();
  });

  it('refuses construction when engine is not bullmq', () => {
    expect(() => new ActiveServerBetaQueueManager(sqliteConfig)).toThrow(/CLAUDE_MEM_QUEUE_ENGINE=bullmq/);
  });

  it('reports active health with all four lanes when constructed against bullmq', () => {
    const { queues } = buildStubQueues();
    const manager = new ActiveServerBetaQueueManager(bullmqConfig, queues);
    const health = manager.getHealth();
    expect(health.status).toBe('active');
    expect(health.details?.engine).toBe('bullmq');
    const lanes = health.details?.lanes as Array<{ kind: string; name: string }> | undefined;
    expect(lanes?.map((l) => l.kind).sort()).toEqual(['event', 'event-batch', 'reindex', 'summary']);
  });

  it('exposes per-kind queues via getQueue', () => {
    const { queues } = buildStubQueues();
    const manager = new ActiveServerBetaQueueManager(bullmqConfig, queues);
    expect(manager.getQueue('event')).toBe(queues.get('event'));
    expect(manager.getQueue('summary')).toBe(queues.get('summary'));
  });

  it('closes every queue on close() and reports errored health afterwards', async () => {
    const { queues, closedNames } = buildStubQueues();
    const manager = new ActiveServerBetaQueueManager(bullmqConfig, queues);
    await manager.close();
    expect(closedNames.sort()).toEqual(['event', 'event-batch', 'reindex', 'summary']);
    expect(manager.getHealth().status).toBe('errored');
  });
});
