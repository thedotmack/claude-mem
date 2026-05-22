import { describe, expect, test } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import {
  __setExternalMemoryDriverLoaderForTesting,
  closeExternalMemorySyncService,
  ExternalMemorySyncService,
  getExternalMemorySyncService,
} from '../../../src/services/external-memory/sync-service.js';

class FakeStore {
  observations: unknown[] = [];
  summaries: unknown[] = [];

  async upsertObservation(input: unknown) {
    this.observations.push(input);
    return { id: 100 + this.observations.length, createdAtEpoch: (input as { createdAtEpoch: number }).createdAtEpoch };
  }

  async upsertSummary(input: unknown) {
    this.summaries.push(input);
    return { id: 200 + this.summaries.length, createdAtEpoch: (input as { createdAtEpoch: number }).createdAtEpoch };
  }
}

class FakeCache {
  items: unknown[] = [];

  async cacheItem(item: unknown) {
    this.items.push(item);
  }
}

describe('ExternalMemorySyncService', () => {
  test('mirrors stored observations and summaries into Postgres then Valkey cache', async () => {
    const store = new FakeStore();
    const cache = new FakeCache();
    const service = new ExternalMemorySyncService(store, cache);

    const result = await service.syncBatch({
      memorySessionId: 'memory-session-1',
      project: 'claude-mem',
      promptNumber: 4,
      discoveryTokens: 321,
      createdAtEpoch: 1_700_000_000_000,
      observationIds: [11, 12],
      observations: [
        {
          type: 'decision',
          title: 'External storage',
          subtitle: null,
          facts: ['Postgres stores searchable memory'],
          narrative: 'Mirror observations externally.',
          concepts: ['postgres'],
          files_read: [],
          files_modified: [],
        },
        {
          type: 'implementation',
          title: 'Valkey cache',
          subtitle: null,
          facts: [],
          narrative: 'Cache recent memory IDs.',
          concepts: ['valkey'],
          files_read: [],
          files_modified: [],
        },
      ],
      summaryId: 21,
      summary: {
        request: 'Add external storage',
        investigated: 'SQLite storage path',
        learned: 'External storage should be optional',
        completed: 'Implemented mirror extension',
        next_steps: 'Run verification',
        notes: null,
      },
    });

    expect(result).toEqual({ observationsWritten: 2, summariesWritten: 1, cacheWrites: 3 });
    expect(store.observations).toHaveLength(2);
    expect(store.observations[0]).toMatchObject({ sqliteId: 11, memorySessionId: 'memory-session-1', project: 'claude-mem' });
    expect(store.summaries[0]).toMatchObject({ sqliteId: 21, memorySessionId: 'memory-session-1', project: 'claude-mem' });
    expect(cache.items).toHaveLength(3);
  });


  test('stores primary batches directly in Postgres and Valkey without SQLite ids', async () => {
    const store = new FakeStore();
    const cache = new FakeCache();
    const service = new ExternalMemorySyncService(store, cache);

    const result = await service.storePrimaryBatch({
      memorySessionId: 'memory-session-primary',
      project: 'claude-mem',
      promptNumber: 5,
      discoveryTokens: 111,
      createdAtEpoch: 1_700_000_000_123,
      observations: [
        { type: 'decision', title: 'Primary Postgres', subtitle: null, facts: [], narrative: 'No SQLite observation row.', concepts: ['postgres'], files_read: [], files_modified: [] },
      ],
      summary: {
        request: 'Use Postgres primary',
        investigated: 'SQLite write path',
        learned: 'Primary mode can write external ids directly',
        completed: 'Stored primary batch',
        next_steps: 'Verify worker retrieval',
        notes: null,
      },
    });

    expect(result).toEqual({ observationIds: [101], summaryId: 201, createdAtEpoch: 1_700_000_000_123 });
    expect(store.observations[0]).toMatchObject({ sqliteId: null, memorySessionId: 'memory-session-primary' });
    expect(store.summaries[0]).toMatchObject({ sqliteId: null, memorySessionId: 'memory-session-primary' });
    expect(cache.items).toHaveLength(2);
  });

  test('rolls back primary batch transaction before cache writes when a Postgres write fails', async () => {
    const store = new FakeStore();
    store.upsertObservation = async (input: unknown) => {
      store.observations.push(input);
      if ((input as { title: string | null }).title === 'Second') {
        throw new Error('Postgres unavailable');
      }
      return { id: 100 + store.observations.length, createdAtEpoch: (input as { createdAtEpoch: number }).createdAtEpoch };
    };
    const cache = new FakeCache();
    const events: string[] = [];
    const service = new ExternalMemorySyncService(new FakeStore(), cache, async fn => {
      events.push('BEGIN');
      try {
        const result = await fn(store);
        events.push('COMMIT');
        return result;
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      }
    });

    await expect(service.storePrimaryBatch({
      memorySessionId: 'memory-session-primary',
      project: 'claude-mem',
      promptNumber: 5,
      discoveryTokens: 111,
      createdAtEpoch: 1_700_000_000_123,
      observations: [
        { type: 'decision', title: 'First', subtitle: null, facts: [], narrative: 'first', concepts: [], files_read: [], files_modified: [] },
        { type: 'decision', title: 'Second', subtitle: null, facts: [], narrative: 'second', concepts: [], files_read: [], files_modified: [] },
      ],
      summary: null,
    })).rejects.toThrow('Postgres unavailable');

    expect(events).toEqual(['BEGIN', 'ROLLBACK']);
    expect(cache.items).toHaveLength(0);
  });

  test('keeps primary Postgres storage authoritative when Valkey cache write fails', async () => {
    const store = new FakeStore();
    const cache = new FakeCache();
    cache.cacheItem = async (item: unknown) => {
      cache.items.push(item);
      throw new Error('Valkey unavailable');
    };
    const warnings: Array<{ component: string; message: string; context: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((component, message, context) => {
      warnings.push({ component, message, context });
    }) as typeof logger.warn;

    try {
      const service = new ExternalMemorySyncService(store, cache);
      const result = await service.storePrimaryBatch({
        memorySessionId: 'memory-session-primary',
        project: 'claude-mem',
        promptNumber: 5,
        discoveryTokens: 111,
        createdAtEpoch: 1_700_000_000_123,
        observations: [
          { type: 'decision', title: 'Primary Postgres', subtitle: null, facts: [], narrative: 'No SQLite observation row.', concepts: ['postgres'], files_read: [], files_modified: [] },
        ],
        summary: null,
      });

      expect(result).toEqual({ observationIds: [101], summaryId: null, createdAtEpoch: 1_700_000_000_123 });
      expect(store.observations).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        component: 'EXTERNAL_MEMORY',
        message: 'Failed to cache primary external memory item; Postgres write remains authoritative',
      });
    } finally {
      logger.warn = originalWarn;
    }
  });

  test('continues syncing later items when one external write fails', async () => {
    const store = new FakeStore();
    store.upsertObservation = async (input: unknown) => {
      store.observations.push(input);
      if ((input as { sqliteId: number }).sqliteId === 11) {
        throw new Error('Postgres unavailable');
      }
      return { id: 112, createdAtEpoch: (input as { createdAtEpoch: number }).createdAtEpoch };
    };
    const cache = new FakeCache();
    const service = new ExternalMemorySyncService(store, cache);

    const result = await service.syncBatch({
      memorySessionId: 'memory-session-1',
      project: 'claude-mem',
      promptNumber: 4,
      discoveryTokens: 321,
      createdAtEpoch: 1_700_000_000_000,
      observationIds: [11, 12],
      observations: [
        { type: 'decision', title: 'Fail', subtitle: null, facts: [], narrative: 'first', concepts: [], files_read: [], files_modified: [] },
        { type: 'decision', title: 'Pass', subtitle: null, facts: [], narrative: 'second', concepts: [], files_read: [], files_modified: [] },
      ],
      summaryId: null,
      summary: null,
    });

    expect(result).toEqual({ observationsWritten: 1, summariesWritten: 0, cacheWrites: 1 });
    expect(cache.items).toHaveLength(1);
  });

  test('warns when observation IDs and observations have different lengths', async () => {
    const store = new FakeStore();
    const cache = new FakeCache();
    const service = new ExternalMemorySyncService(store, cache);
    const warnings: Array<{ component: string; message: string; context: unknown }> = [];
    const originalWarn = logger.warn;
    logger.warn = ((component, message, context) => {
      warnings.push({ component, message, context });
    }) as typeof logger.warn;

    try {
      const result = await service.syncBatch({
        memorySessionId: 'memory-session-1',
        project: 'claude-mem',
        promptNumber: 4,
        discoveryTokens: 321,
        createdAtEpoch: 1_700_000_000_000,
        observationIds: [11],
        observations: [
          { type: 'decision', title: 'Mirror one', subtitle: null, facts: [], narrative: 'first', concepts: [], files_read: [], files_modified: [] },
          { type: 'decision', title: 'Missing id', subtitle: null, facts: [], narrative: 'second', concepts: [], files_read: [], files_modified: [] },
        ],
        summaryId: null,
        summary: null,
      });

      expect(result).toEqual({ observationsWritten: 1, summariesWritten: 0, cacheWrites: 1 });
      expect(warnings).toEqual([
        {
          component: 'EXTERNAL_MEMORY',
          message: 'Observation ID count did not match observation count; unmatched observations will be skipped',
          context: {
            project: 'claude-mem',
            observationCount: 2,
            observationIdCount: 1,
          },
        },
      ]);
    } finally {
      logger.warn = originalWarn;
    }
  });

  test('shares one Postgres/Valkey runtime across concurrent initialization calls', async () => {
    let loaderCalls = 0;
    let poolConstructors = 0;
    let redisConstructors = 0;

    class FakeRuntimePool {
      constructor(_options: unknown) {
        poolConstructors++;
      }

      async query(text: string) {
        if (text.includes('format_type(a.atttypid, a.atttypmod)')) {
          return { rows: [{ embedding_type: 'vector(1536)' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      async end() {
        return undefined;
      }
    }

    class FakeRuntimeRedis {
      constructor(_url: string, _options: unknown) {
        redisConstructors++;
      }

      async set() {
        return 'OK';
      }

      async get() {
        return null;
      }

      async zadd() {
        return 1;
      }

      async zrevrange() {
        return [];
      }

      async expire() {
        return 1;
      }

      async quit() {
        return 'OK';
      }

      disconnect() {
        return undefined;
      }
    }

    const restoreDriverLoader = __setExternalMemoryDriverLoaderForTesting(async () => {
      loaderCalls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        Pool: FakeRuntimePool,
        Redis: FakeRuntimeRedis,
      };
    });

    try {
      await closeExternalMemorySyncService();
      const env = {
        CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED: 'true',
        CLAUDE_MEM_PG_URL: 'postgres://claude_mem:test@127.0.0.1:15432/claude_mem',
        CLAUDE_MEM_VALKEY_URL: 'redis://:test@127.0.0.1:16379',
      };

      const [first, second] = await Promise.all([
        getExternalMemorySyncService(env),
        getExternalMemorySyncService(env),
      ]);

      expect(first).toBe(second);
      expect(loaderCalls).toBe(1);
      expect(poolConstructors).toBe(1);
      expect(redisConstructors).toBe(1);
    } finally {
      await closeExternalMemorySyncService();
      restoreDriverLoader();
    }
  });
});
