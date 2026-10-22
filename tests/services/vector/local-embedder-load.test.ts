import { afterAll, describe, expect, it, mock } from 'bun:test';

// The real module, restored after this file: bun shares modules across test
// files, so a mock left in place would fail every later real model load.
const real = { ...(await import('@huggingface/transformers')) };

let loads = 0;
const failingLoad = async () => {
  loads += 1;
  throw new Error(`model download failed (${loads})`);
};
mock.module('@huggingface/transformers', () => ({
  ...real,
  AutoTokenizer: { from_pretrained: failingLoad },
  AutoModel: { from_pretrained: failingLoad },
}));

afterAll(() => {
  mock.module('@huggingface/transformers', () => real);
});

const { LocalEmbedder } = await import('../../../src/services/vector/LocalEmbedder.js');

describe('LocalEmbedder model load', () => {
  it('retries a failed load on the next call', async () => {
    const embedder = new LocalEmbedder();
    await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (1)');
    await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (2)');
    expect(loads).toBe(2);
  });
});
