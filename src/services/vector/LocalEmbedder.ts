import type { Embedder } from './types.js';

/**
 * Documents per forward pass.
 *
 * A batch is padded to its longest member and run as one graph execution, so
 * activation memory grows with the batch. The caller's array length is
 * whatever a row set happened to render to, which is not a size to hand a
 * model unchecked.
 */
const EMBED_CHUNK_SIZE = 32;

/**
 * all-MiniLM-L6-v2 via transformers.js, in-process.
 *
 * Same model and dimensionality Chroma used (its default embedding function),
 * so retrieval behaviour is unchanged — but produced in-process instead of by a
 * Python subprocess spawned through uvx. That subprocess is what actually broke:
 * #3012 reports it respawning continuously and crashing in bulk, and every
 * Windows-specific workaround in the old ChromaMcpManager existed to babysit it.
 *
 * onnxruntime-node MUST stay pinned to 1.21.0. From 1.24 they stopped shipping a
 * darwin/x64 binary, which would silently strand every Intel Mac user — and Intel
 * Macs are exactly where the #3012 reports came from. 1.21.0 ships all six
 * targets: {linux,darwin,win32} x {x64,arm64}.
 */
export class LocalEmbedder implements Embedder {
  readonly modelId = 'Xenova/all-MiniLM-L6-v2/fp32/mean/l2';
  readonly dims = 384;

  private extractor: unknown = null;
  private loading: Promise<unknown> | null = null;

  /**
   * Model init costs ~3s, so it is deferred until something is actually
   * embedded — a worker that only reads never pays it. Concurrent callers
   * share one in-flight load rather than racing to initialise twice.
   */
  private async ready(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
          dtype: 'fp32',
        });
        return this.extractor;
      })();
    }
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBED_CHUNK_SIZE) {
      const chunk = await this.encode(texts.slice(start, start + EMBED_CHUNK_SIZE));
      for (const vector of chunk) vectors.push(vector);
    }
    return vectors;
  }

  protected async encode(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.ready();
    // pooling+normalize are done in the model graph, so vectors come back
    // unit-length and cosine reduces to a dot product at query time.
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const flat = out.data as Float32Array;
    return texts.map((_, i) => {
      const slice = new Float32Array(this.dims);
      slice.set(flat.subarray(i * this.dims, (i + 1) * this.dims));
      return slice;
    });
  }
}
