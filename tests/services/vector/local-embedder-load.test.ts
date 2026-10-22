import { describe, expect, it, mock } from 'bun:test';

let loads = 0;
mock.module('@huggingface/transformers', () => ({
  pipeline: async () => {
    loads += 1;
    throw new Error(`model download failed (${loads})`);
  },
}));

const { LocalEmbedder } = await import('../../../src/services/vector/LocalEmbedder.js');

describe('LocalEmbedder model load', () => {
  it('retries a failed load on the next call', async () => {
    const embedder = new LocalEmbedder();
    await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (1)');
    await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (2)');
    expect(loads).toBe(2);
  });
});
