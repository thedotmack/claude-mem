import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../src/services/vector/models.js';

test('a model with a different hidden width cannot mix token rows into plausible embeddings', async () => {
  const embedder = new LocalEmbedder({ ...DEFAULT_EMBEDDING_MODEL, dims: 2 });
  const tokens = { dims: [2, 1], data: new BigInt64Array([1n, 1n]) };
  const tokenizer = Object.assign(() => ({ input_ids: tokens, attention_mask: tokens }), { sep_token_id: 2 });
  Object.assign(embedder, { extractor: {
    tokenizer,
    model: async () => ({ last_hidden_state: {
      dims: [2, 1, 4], data: new Float32Array([1, 0, 1, 1, 0, 1, 0, 0]),
    } }),
  } });
  await assert.rejects(embedder.embed(['first', 'second']), /embedding tensor shape/);
});
