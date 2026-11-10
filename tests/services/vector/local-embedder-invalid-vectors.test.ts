import { describe, expect, test } from 'bun:test';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../src/services/vector/models.js';
import { embedObservationRows, embedSearchQuery } from '../../../src/server/services/ObservationEmbeddingService.js';
import type { PostgresQueryable } from '../../../src/storage/postgres/utils.js';

function controlledEmbedder(values: number[], mask: bigint[] = [1n], pooling: 'mean' | 'cls' = 'mean') {
  const embedder = new LocalEmbedder({ ...DEFAULT_EMBEDDING_MODEL, dims: 2, pooling });
  const tokenizer = Object.assign(() => ({
    input_ids: { dims: [1, mask.length], data: new BigInt64Array(mask.length).fill(1n) },
    attention_mask: { dims: [1, mask.length], data: new BigInt64Array(mask) },
  }), { sep_token_id: 2 });
  Object.assign(embedder, { extractor: { tokenizer, model: async () => ({
    last_hidden_state: { dims: [1, mask.length, 2], data: new Float32Array(values) },
  }) } });
  return embedder;
}

describe('embedding normalization rejects unusable model output', () => {
  for (const pooling of ['mean', 'cls'] as const) {
    for (const [name, values] of [
      ['zero vector', [0, 0]],
      ['NaN component', [NaN, 1]],
      ['infinite component', [Infinity, 1]],
    ] as const) {
      test(`${pooling}: ${name}`, async () => {
        await expect(controlledEmbedder([...values], [1n], pooling).embed(['note'])).rejects.toThrow(/embedding.*norm/i);
      });
    }
  }

  test('an empty attention mask is rejected before producing a NaN vector', async () => {
    await expect(controlledEmbedder([1, 2], [0n]).embed(['note'])).rejects.toThrow(/embedding.*norm/i);
  });

  test('masked padding does not invalidate a usable mean-pooled vector', async () => {
    const [vector] = await controlledEmbedder([3, 4, NaN, Infinity], [1n, 0n]).embed(['note']);
    expect([...vector!]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
  });

  test('failed normalization uses the existing keyword and write-without-vectors fallbacks', async () => {
    const client = { query: async () => ({ rows: [{ present: true }] }) } as unknown as PostgresQueryable;
    const embedder = controlledEmbedder([0, 0]);
    expect(await embedSearchQuery(client, 'query', embedder)).toBeNull();
    expect(await embedObservationRows(client, [{ kind: 'observation', metadata: {}, content: 'note' }], embedder)).toBeNull();
  });
});
