import { describe, expect, test } from 'bun:test';
import { ExternalMemorySyncService } from '../../../src/services/external-memory/sync-service.js';

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
  test('mirrors stored observations and summaries into pgvector then Valkey cache', async () => {
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
          facts: ['pgvector stores searchable memory'],
          narrative: 'Mirror observations externally.',
          concepts: ['pgvector'],
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

  test('continues syncing later items when one external write fails', async () => {
    const store = new FakeStore();
    store.upsertObservation = async (input: unknown) => {
      store.observations.push(input);
      if ((input as { sqliteId: number }).sqliteId === 11) {
        throw new Error('pgvector unavailable');
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
});
