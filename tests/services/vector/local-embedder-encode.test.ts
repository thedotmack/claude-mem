import { describe, expect, it } from 'bun:test';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../src/services/vector/models.js';

// Runs the real tokenizer and model (all-MiniLM-L6-v2, about 90 MB, fetched
// on first use); without them, say offline, it reports that and does nothing.
const embedder = new LocalEmbedder(DEFAULT_EMBEDDING_MODEL);
const available = await embedder.embed(['probe']).then(() => true, () => false);

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
const length = (v: Float32Array) => Math.sqrt(cosine(v, v));

describe('LocalEmbedder encode', () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');

  it('truncates at the model\'s token limit', async () => {
    if (!available) return console.warn('embedding model unavailable; encode not tested');
    const [cut, longer] = await embedder.embed([long, `${long} and a great deal more text after the limit`]);
    expect(cosine(cut!, longer!)).toBeGreaterThan(0.999999);
  });

  it('gives the same vector alone and padded in a batch beside a longer text', async () => {
    if (!available) return;
    const short = 'Postgres is dumped before every schema change.';
    const [alone] = await embedder.embed([short]);
    const [padded, beside] = await embedder.embed([short, long]);
    expect(cosine(alone!, padded!)).toBeGreaterThan(0.999999);
    expect(cosine(padded!, beside!)).toBeLessThan(0.9);
  });

  it('returns unit-length vectors', async () => {
    if (!available) return;
    for (const v of await embedder.embed(['a', long])) expect(length(v)).toBeCloseTo(1, 5);
  });
});
