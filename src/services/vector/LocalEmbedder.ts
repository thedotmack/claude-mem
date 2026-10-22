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
 * Characters per forward pass.
 *
 * A document count is not a size. 32 documents is a few kilobytes of ordinary
 * narrative and 12MB of 400KB facts, and the tokenizer walks every character
 * of both before the model truncates anything. Whichever cap binds first,
 * binds — and a chunk is never empty, so one document longer than the whole
 * budget still goes through on its own rather than wedging the loop.
 */
const EMBED_CHUNK_CHARS = 256 * 1024;

/**
 * all-MiniLM-L6-v2 via transformers.js, in-process.
 *
 * Same model and dimensionality Chroma used (its default embedding function),
 * so retrieval behaviour is unchanged — but produced in-process instead of by a
 * Python subprocess spawned through uvx. That subprocess is what actually broke:
 * #3012 reports it respawning continuously and crashing in bulk, and every
 * Windows-specific workaround in the old ChromaMcpManager existed to babysit it.
 *
 * onnxruntime-node is pinned below 1.24 for Intel Macs; see the plugin
 * `overrides` in scripts/build-hooks.js.
 */
/**
 * The length all-MiniLM-L6-v2 was trained at, and where Chroma truncates.
 * The tokenizer's model_max_length says 512.
 */
const MAX_TOKENS = 256;

export class LocalEmbedder implements Embedder {
  // The token limit is part of the identity: the same model truncated
  // elsewhere produces different vectors for long texts.
  readonly modelId = `Xenova/all-MiniLM-L6-v2/fp32/mean/l2/${MAX_TOKENS}`;
  readonly dims = 384;

  private extractor: { tokenizer: any; model: any } | null = null;
  private loading: Promise<{ tokenizer: any; model: any }> | null = null;

  /**
   * `threads` caps onnxruntime's intra-op threads; unset, it takes every CPU
   * thread. Fixed when the model loads.
   */
  constructor(readonly threads?: number) {}

  /**
   * Model init costs ~3s, so it is deferred until something is actually
   * embedded — a worker that only reads never pays it. Concurrent callers
   * share one in-flight load rather than racing to initialise twice.
   */
  private async ready(): Promise<{ tokenizer: any; model: any }> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        const { AutoModel, AutoTokenizer } = await import('@huggingface/transformers');
        this.extractor = {
          tokenizer: await AutoTokenizer.from_pretrained('Xenova/all-MiniLM-L6-v2'),
          model: await AutoModel.from_pretrained('Xenova/all-MiniLM-L6-v2', {
            dtype: 'fp32',
            ...(this.threads ? { session_options: { intraOpNumThreads: this.threads } } : {}),
          }),
        };
        return this.extractor;
      })().catch((error: unknown) => {
        // A failed load (a download error, say) is retried by the next call
        // rather than failing every call until the process restarts.
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const vectors: Float32Array[] = [];
    let start = 0;
    while (start < texts.length) {
      const end = this.chunkEnd(texts, start);
      const chunk = await this.encode(texts.slice(start, end));
      for (const vector of chunk) vectors.push(vector);
      start = end;
    }
    return vectors;
  }

  /** Exclusive end of the chunk beginning at `start`; always past `start`. */
  private chunkEnd(texts: string[], start: number): number {
    let end = start;
    let chars = 0;
    while (end < texts.length) {
      if (end > start && (end - start >= EMBED_CHUNK_SIZE || chars + texts[end].length > EMBED_CHUNK_CHARS)) {
        break;
      }
      chars += texts[end].length;
      end++;
    }
    return end;
  }

  /**
   * The tokenizer and model are called directly, not through the
   * feature-extraction pipeline, which truncates at the tokenizer's
   * model_max_length (512) rather than the length the model was trained at:
   * for all-MiniLM-L6-v2 that is 256, which Chroma uses, and a text of 936 to
   * 1,716 tokens embedded at 512 came out at cosine 0.79 to 0.83 from Chroma's
   * vector. Truncation also drops the closing [SEP], which transformers.js
   * 4.3.1 adds before cutting (huggingface/tokenizers.js#41); it is restored
   * here. With both, vectors match Chroma's to cosine 0.9999995.
   */
  protected async encode(texts: string[]): Promise<Float32Array[]> {
    const { tokenizer, model } = await this.ready();
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS });
    const [rows, width] = inputs.input_ids.dims as number[];
    const ids = inputs.input_ids.data as BigInt64Array;
    const mask = inputs.attention_mask.data as BigInt64Array;
    const sep = BigInt(tokenizer.sep_token_id);
    if (width === MAX_TOKENS) {
      for (let r = 0; r < rows; r++) {
        const last = r * width + MAX_TOKENS - 1;
        if (mask[last] === 1n && ids[last] !== sep) ids[last] = sep;
      }
    }
    const { last_hidden_state: hidden } = await model(inputs);
    const h = hidden.data as Float32Array;
    // Mean over the real tokens, then unit length, so cosine reduces to a dot
    // product at query time.
    return texts.map((_, r) => {
      const v = new Float32Array(this.dims);
      let n = 0;
      for (let t = 0; t < width; t++) {
        if (mask[r * width + t] !== 1n) continue;
        n++;
        const base = (r * width + t) * this.dims;
        for (let d = 0; d < this.dims; d++) v[d] += h[base + d];
      }
      let norm = 0;
      for (let d = 0; d < this.dims; d++) {
        v[d] /= n;
        norm += v[d] * v[d];
      }
      norm = Math.sqrt(norm);
      for (let d = 0; d < this.dims; d++) v[d] /= norm;
      return v;
    });
  }
}
