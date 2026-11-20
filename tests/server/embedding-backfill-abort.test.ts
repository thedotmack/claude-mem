import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { backfillMissingEmbeddings } from '../../src/server/services/ObservationEmbeddingService.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { PostgresQueryable } from '../../src/storage/postgres/utils.js';
import type { Embedder } from '../../src/services/vector/types.js';

afterEach(() => mock.restore());

function database(onRead?: () => void) {
  let reads = 0;
  let writes = 0;
  let unlocks = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) {
        unlocks++;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO observation_embeddings')) {
        writes++;
        return { rows: [] };
      }
      if (sql.includes('SELECT o.id, o.kind')) {
        if (reads++ > 0) return { rows: [] };
        onRead?.();
        return {
          rows: ['first', 'second'].map(id => ({
            id, kind: 'manual', content: id, metadata: {},
            created_at: '2026-01-01 00:00:00+00',
          })),
        };
      }
      throw new Error(`Unexpected backfill query: ${sql}`);
    },
  } as PostgresQueryable;
  spyOn(SettingsDefaultsManager, 'get').mockReturnValue('true');
  return { client, writes: () => writes, unlocks: () => unlocks };
}

function embedder(embed: Embedder['embed']): Embedder {
  return { modelId: 'test-model', dims: 2, embed };
}

test('does not start embedding when shutdown arrives during the database read', async () => {
  const stop = new AbortController();
  const db = database(() => stop.abort());
  const embed = mock(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));

  expect(await backfillMissingEmbeddings(db.client, { embedder: embedder(embed), signal: stop.signal }))
    .toEqual({ observations: 0, parts: 0 });
  expect(embed).not.toHaveBeenCalled();
  expect(db.writes()).toBe(0);
  expect(db.unlocks()).toBe(1);
});

test('does not retry a failed batch after shutdown has been requested', async () => {
  const stop = new AbortController();
  const db = database();
  const embed = mock(async () => {
    stop.abort();
    throw new Error('embedding stopped');
  });

  expect(await backfillMissingEmbeddings(db.client, { embedder: embedder(embed), signal: stop.signal }))
    .toEqual({ observations: 0, parts: 0 });
  expect(embed).toHaveBeenCalledTimes(1);
  expect(db.writes()).toBe(0);
  expect(db.unlocks()).toBe(1);
});

test('stops between individual row attempts when shutdown arrives during a retry', async () => {
  const stop = new AbortController();
  const db = database();
  const embed = mock(async (texts: string[]) => {
    if (texts.length > 1) throw new Error('batch failed');
    stop.abort();
    return [new Float32Array([1, 0])];
  });

  expect(await backfillMissingEmbeddings(db.client, { embedder: embedder(embed), signal: stop.signal }))
    .toEqual({ observations: 0, parts: 0 });
  expect(embed.mock.calls.map(([texts]) => texts)).toEqual([['first', 'second'], ['first']]);
  expect(db.writes()).toBe(0);
  expect(db.unlocks()).toBe(1);
});

test('still embeds individual rows after a batch failure without shutdown', async () => {
  const db = database();
  const embed = mock(async (texts: string[]) => {
    if (texts.length > 1) throw new Error('batch failed');
    return [new Float32Array([1, 0])];
  });

  expect(await backfillMissingEmbeddings(db.client, { embedder: embedder(embed) }))
    .toEqual({ observations: 2, parts: 2 });
  expect(embed).toHaveBeenCalledTimes(3);
  expect(db.writes()).toBe(2);
  expect(db.unlocks()).toBe(1);
});
