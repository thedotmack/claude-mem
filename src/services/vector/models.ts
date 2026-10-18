/**
 * Embedding models, and what each one fixes about the stores that hold its
 * vectors.
 *
 * all-MiniLM-L6-v2 is the default because it is what Chroma used, so moving
 * off Chroma changes no ranking. It is English-only: its 30k-entry vocabulary
 * reduces Chinese, Japanese and Korean text to single characters or [UNK],
 * which is where the CJK recall gap measured in #3422 comes from (plan-25,
 * #3982). This table exists so other models, multilingual ones especially,
 * can be evaluated against it by adding an entry rather than editing the
 * embedder and the schema separately. A model's vector length is not a free
 * choice: the server's Postgres column is declared vector(dims), so the
 * schema reads it from here (see applyVectorSchema).
 */
export interface EmbeddingModel {
  /** Hugging Face repository transformers.js loads. */
  repo: string;
  dtype: 'fp32';
  pooling: 'mean';
  /** Vector length; sizes the server's vector(n) column. */
  dims: number;
}

export const EMBEDDING_MODELS = {
  'all-MiniLM-L6-v2': {
    repo: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'fp32',
    pooling: 'mean',
    dims: 384,
  },
} satisfies Record<string, EmbeddingModel>;

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = EMBEDDING_MODELS['all-MiniLM-L6-v2'];
