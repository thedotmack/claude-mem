import { afterEach, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { backfillMissingEmbeddings } from '../../src/server/services/ObservationEmbeddingService.js';
import type { PostgresQueryable } from '../../src/storage/postgres/utils.js';
import type { Embedder } from '../../src/services/vector/types.js';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function setup(at: 'read' | 'embed' | 'write' | 'none', event: 'error' | 'end' = 'error') {
  const lost = new Error('lock connection terminated');
  let reads = 0;
  let writes = 0;
  let calls = 0;
  let unlocks = 0;
  let closed = 0;
  class LockConnection extends EventEmitter {
    async connect() {}
    async end() { closed++; this.emit('end'); }
    async query(sql: string) {
      if (sql.includes('pg_advisory_unlock')) unlocks++;
      return { rows: [{ locked: true }] };
    }
  }
  const lock = new LockConnection();
  const constructor = spyOn(pg, 'Client').mockImplementation(function () { return lock; } as any);
  restores.push(() => constructor.mockRestore());
  const fail = () => event === 'error' ? lock.emit('error', lost) : lock.emit('end');
  const client = {
    options: {}, connect: async () => { throw new Error('must not borrow a pool connection'); },
    query: async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
      if (sql.includes('INSERT INTO observation_embeddings')) {
        writes++;
        if (at === 'write' && writes === 1) fail();
        return { rows: [] };
      }
      reads++;
      if (at === 'read' && reads === 1) fail();
      return { rows: reads === 1 ? ['first', 'second'].map(id => ({
        id, kind: 'observation', metadata: {}, content: id, created_at: '2026-01-01 00:00:00+00',
      })) : [] };
    },
  } as unknown as PostgresQueryable;
  const embedder: Embedder = {
    modelId: 'controlled', dims: 2,
    embed: async texts => {
      calls++;
      if (at === 'embed') fail();
      return texts.map(() => new Float32Array([1, 0]));
    },
  };
  return { client, embedder, lock, counts: () => ({ reads, writes, calls, unlocks, closed }) };
}

for (const event of ['error', 'end'] as const) {
  test(`stops before embedding if its advisory-lock connection emits ${event} during the read`, async () => {
    const fixture = setup('read', event);
    expect(await backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).toEqual({ observations: 0, parts: 0 });
    expect(fixture.counts()).toEqual({ reads: 1, writes: 0, calls: 0, unlocks: 0, closed: 1 });
    expect(fixture.lock.listenerCount('end')).toBe(0);
  });
}

test('does not publish the embedding produced after its lock connection was lost', async () => {
  const fixture = setup('embed');
  expect(await backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).toEqual({ observations: 0, parts: 0 });
  expect(fixture.counts()).toEqual({ reads: 1, writes: 0, calls: 1, unlocks: 0, closed: 1 });
});

test('finishes only the already-issued write after losing ownership mid-batch', async () => {
  const fixture = setup('write');
  expect(await backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).toEqual({ observations: 1, parts: 1 });
  expect(fixture.counts()).toEqual({ reads: 1, writes: 1, calls: 1, unlocks: 0, closed: 1 });
});

test('normal completion unlocks and closes the dedicated connection', async () => {
  const fixture = setup('none');
  expect(await backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).toEqual({ observations: 2, parts: 2 });
  expect(fixture.counts()).toEqual({ reads: 2, writes: 2, calls: 1, unlocks: 1, closed: 1 });
});

test('does not retry individual rows after losing its lock in a failed model batch', async () => {
  const fixture = setup('none');
  let calls = 0;
  fixture.embedder.embed = async () => {
    calls++;
    fixture.lock.emit('error', new Error('connection ended'));
    throw new Error('model batch failed');
  };
  expect(await backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).toEqual({ observations: 0, parts: 0 });
  expect(calls).toBe(1);
  expect(fixture.counts().writes).toBe(0);
  expect(fixture.counts().closed).toBe(1);
});

test('closes its owned client when connecting fails', async () => {
  const fixture = setup('none');
  const failure = new Error('database refused connection');
  fixture.lock.connect = async () => { throw failure; };
  await expect(backfillMissingEmbeddings(fixture.client, { embedder: fixture.embedder })).rejects.toBe(failure);
  expect(fixture.counts().closed).toBe(1);
  expect(fixture.lock.listenerCount('error')).toBe(0);
});
