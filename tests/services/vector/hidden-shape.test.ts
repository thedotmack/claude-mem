import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../src/services/vector/models.js';

// Two one-token texts at width two require shape [2, 1, 2] and four values.
for (const { mismatch, dims, length } of [
  { mismatch: 'wider model', dims: [2, 1, 4], length: 8 },
  { mismatch: 'rank', dims: [2, 1, 2, 1], length: 4 },
  { mismatch: 'batch dimension', dims: [1, 1, 2], length: 4 },
  { mismatch: 'token dimension', dims: [2, 2, 2], length: 4 },
  { mismatch: 'hidden width', dims: [2, 1, 4], length: 4 },
  { mismatch: 'buffer length', dims: [2, 1, 2], length: 8 },
]) {
  test(`rejects an incompatible hidden tensor: ${mismatch}`, async () => {
    const embedder = new LocalEmbedder({ ...DEFAULT_EMBEDDING_MODEL, dims: 2 });
    const tokens = { dims: [2, 1], data: new BigInt64Array([1n, 1n]) };
    const tokenizer = Object.assign(() => ({ input_ids: tokens, attention_mask: tokens }), { sep_token_id: 2 });
    Object.assign(embedder, { extractor: {
      tokenizer,
      model: async () => ({ last_hidden_state: {
        dims, data: new Float32Array([1, 0, 1, 1, 0, 1, 0, 0]).subarray(0, length),
      } }),
    } });
    await assert.rejects(embedder.embed(['first', 'second']), /embedding tensor shape/);
  });
}
