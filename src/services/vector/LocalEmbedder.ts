import type { Embedder } from './types.js';

/**
 * Documents per forward pass.
 *
 * A batch is padded to its longest member and run as one graph execution, so
 * activation memory grows with the batch. The caller's array length is
 * whatever a row set happened to render to, which is not a size to hand a
 * model unchecked. onnxruntime-node runs a pass on the event loop's thread, so
 * a pass also blocks every request in the process for its length: on 256
 * observation texts, 32 per pass blocked for up to 750 ms, 4 per pass for
 * about 110 ms, and 4 per pass was no slower overall, padding less.
 */
const EMBED_CHUNK_SIZE = 4;

/**
 * Characters of a text handed to the tokenizer.
 *
 * The tokenizer walks every character before the model truncates to its token
 * limit, so a megabyte of text costs a quarter of a second on the event loop
 * for the same vector as its first few kilobytes. 32 KB holds far more than
 * the token limit of ordinary text; the longest observation in a 39k-row
 * store is 8 KB.
 */
const MAX_TEXT_CHARS = 32 * 1024;

/** How long a failed model load fails every call before the next attempt. */
export const LOAD_RETRY_MS = 5 * 60_000;

/**
 * The length all-MiniLM-L6-v2 was trained at, and where Chroma truncates.
 * The tokenizer's model_max_length says 512.
 */
const MAX_TOKENS = 256;

/**
 * all-MiniLM-L6-v2 via transformers.js, in-process: the model and
 * dimensionality of Chroma's default embedding function, which the worker's
 * search uses, so the server's vectors match the worker's.
 *
 * onnxruntime-node is pinned below 1.24 for Intel Macs; see the plugin
 * `overrides` in scripts/build-hooks.js.
 */
export class LocalEmbedder implements Embedder {
  // The token limit is part of the identity: the same model truncated
  // elsewhere produces different vectors for long texts.
  readonly modelId = `Xenova/all-MiniLM-L6-v2/fp32/mean/l2/${MAX_TOKENS}`;
  readonly dims = 384;

  private extractor: { tokenizer: any; model: any } | null = null;
  private loading: Promise<{ tokenizer: any; model: any }> | null = null;
  // A failed load, and when. Each attempt can take minutes where a firewall
  // drops the download, so calls fail at once until LOAD_RETRY_MS has passed.
  private failed: { error: unknown; at: number } | null = null;

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
    if (this.failed && Date.now() - this.failed.at < LOAD_RETRY_MS) throw this.failed.error;
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
        // A failed load (a download error, say) is retried by a call after
        // LOAD_RETRY_MS rather than failing every call until the process restarts.
        this.loading = null;
        this.failed = { error, at: Date.now() };
        throw error;
      });
    }
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += EMBED_CHUNK_SIZE) {
      const chunk = texts.slice(start, start + EMBED_CHUNK_SIZE).map(text => text.slice(0, MAX_TEXT_CHARS));
      for (const vector of await this.encode(chunk)) vectors.push(vector);
    }
    return vectors;
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
