import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test';

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

const { LocalEmbedder, LOAD_RETRY_MS } = await import('../../../src/services/vector/LocalEmbedder.js');

describe('LocalEmbedder model load', () => {
  it('fails at once after a failed load, and retries once LOAD_RETRY_MS has passed', async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const embedder = new LocalEmbedder();
      await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (1)');
      now += LOAD_RETRY_MS - 1;
      await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (1)');
      expect(loads).toBe(1);
      now += 1;
      await expect(embedder.embed(['a'])).rejects.toThrow('model download failed (2)');
      expect(loads).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});
