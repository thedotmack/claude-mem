import { describe, expect, test } from 'bun:test';
import { ExternalMemoryValkeyCache } from '../../../src/services/external-memory/valkey-cache.js';

class FakeValkey {
  calls: Array<{ command: string; args: unknown[] }> = [];
  private values = new Map<string, string>();

  async set(...args: unknown[]) {
    this.calls.push({ command: 'set', args });
    this.values.set(String(args[0]), String(args[1]));
    return 'OK';
  }

  async get(key: string) {
    this.calls.push({ command: 'get', args: [key] });
    return this.values.get(key) ?? null;
  }

  async zadd(...args: unknown[]) {
    this.calls.push({ command: 'zadd', args });
    return 1;
  }

  async zrevrange(...args: unknown[]) {
    this.calls.push({ command: 'zrevrange', args });
    return ['42', '41'];
  }

  async expire(...args: unknown[]) {
    this.calls.push({ command: 'expire', args });
    return 1;
  }
}

describe('ExternalMemoryValkeyCache', () => {
  test('caches memory items and indexes recent IDs by project with prefix isolation', async () => {
    const valkey = new FakeValkey();
    const cache = new ExternalMemoryValkeyCache(valkey, {
      prefix: 'team-memory',
      ttlSeconds: 60,
    });

    await cache.cacheItem({
      id: 42,
      project: 'claude-mem',
      kind: 'observation',
      content: 'External memory stored in pgvector',
      createdAtEpoch: 1_700_000_000_000,
    });

    expect(valkey.calls).toContainEqual({
      command: 'set',
      args: [
        'team-memory:item:42',
        JSON.stringify({
          id: 42,
          project: 'claude-mem',
          kind: 'observation',
          content: 'External memory stored in pgvector',
          createdAtEpoch: 1_700_000_000_000,
        }),
        'EX',
        60,
      ],
    });
    expect(valkey.calls).toContainEqual({
      command: 'zadd',
      args: ['team-memory:project:claude-mem:recent', 1_700_000_000_000, '42'],
    });
  });

  test('reads cached items and recent project IDs', async () => {
    const valkey = new FakeValkey();
    const cache = new ExternalMemoryValkeyCache(valkey, {
      prefix: 'team-memory',
      ttlSeconds: 60,
    });
    await cache.cacheItem({ id: 42, project: 'claude-mem', kind: 'observation', content: 'cached', createdAtEpoch: 1 });

    await expect(cache.getItem(42)).resolves.toEqual({
      id: 42,
      project: 'claude-mem',
      kind: 'observation',
      content: 'cached',
      createdAtEpoch: 1,
    });
    await expect(cache.getRecentIds('claude-mem', 2)).resolves.toEqual([42, 41]);
  });
});
