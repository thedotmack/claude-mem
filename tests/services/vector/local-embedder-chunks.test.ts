import { describe, expect, it } from 'bun:test';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';

/** Records what each forward pass would receive, without the model. */
class RecordingEmbedder extends LocalEmbedder {
  passes: string[][] = [];
  protected override async encode(texts: string[]): Promise<Float32Array[]> {
    this.passes.push(texts);
    return texts.map(() => new Float32Array(this.dims));
  }
}

describe('LocalEmbedder forward passes', () => {
  it('embeds four texts per pass, in order', async () => {
    const embedder = new RecordingEmbedder();
    const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
    expect(await embedder.embed(texts)).toHaveLength(10);
    expect(embedder.passes.map(pass => pass.length)).toEqual([4, 4, 2]);
    expect(embedder.passes.flat()).toEqual(texts);
  });

  it('hands the tokenizer at most 32 KB of a text', async () => {
    const embedder = new RecordingEmbedder();
    await embedder.embed(['x'.repeat(1024 * 1024), 'short']);
    expect(embedder.passes[0].map(text => text.length)).toEqual([32 * 1024, 5]);
  });
});
