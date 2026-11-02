import { describe, expect, it } from 'bun:test';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../../../src/services/vector/models.js';

// Runs the real tokenizer and model (all-MiniLM-L6-v2, about 90 MB, fetched
// on first use). Without them, say offline, these tests skip, except under
// CLAUDE_MEM_TEST_PGVECTOR=1 (the search CI job), where a model that cannot
// load fails them instead of letting them pass untested.
const requireModel = process.env.CLAUDE_MEM_TEST_PGVECTOR === '1';
const embedder = new LocalEmbedder(DEFAULT_EMBEDDING_MODEL);
const probe = await embedder.embed(['probe']).then(() => null, (error: unknown) => error);
if (probe && !requireModel) {
  console.warn('embedding model unavailable; LocalEmbedder encode not tested:', probe instanceof Error ? probe.message : probe);
}

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

describe.skipIf(probe !== null && !requireModel)('LocalEmbedder encode', () => {
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');

  it('loads the model', () => {
    expect(probe).toBeNull();
  });

  it('returns unit-length 384-dimension vectors', async () => {
    for (const v of await embedder.embed(['a', long])) {
      expect(v).toHaveLength(384);
      expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 5);
    }
  });

  it('places a paraphrase nearer than an unrelated text', async () => {
    const [query] = await embedder.embed(['which machine builds the search index'], 'query');
    const [paraphrase, unrelated] = await embedder.embed([
      'The code-search indexer runs nightly on the build host.',
      'Lunch is at noon on Fridays.',
    ]);
    expect(dot(query!, paraphrase!)).toBeGreaterThan(dot(query!, unrelated!));
  });

  it('truncates at the model\'s token limit', async () => {
    const [cut, longer] = await embedder.embed([long, `${long} and a great deal more text after the limit`]);
    expect(dot(cut!, longer!)).toBeGreaterThan(0.999999);
  });

  it('gives the same vector alone and padded in a batch beside a longer text', async () => {
    const short = 'Postgres is dumped before every schema change.';
    const [alone] = await embedder.embed([short]);
    const [padded, beside] = await embedder.embed([short, long]);
    expect(dot(alone!, padded!)).toBeGreaterThan(0.999999);
    expect(dot(padded!, beside!)).toBeLessThan(0.9);
  });
});
