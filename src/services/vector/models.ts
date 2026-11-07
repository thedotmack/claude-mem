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
 *
 * CLAUDE_MEM_EMBEDDING_MODEL names the entry in use; the other three entries
 * are the multilingual candidates measured in rich-murphey/claude-mem-search-eval.
 */
export interface EmbeddingModel {
  /** Hugging Face repository transformers.js loads. */
  repo: string;
  dtype: 'fp32';
  /** mean: the average over real tokens; cls: the first token's vector. */
  pooling: 'mean' | 'cls';
  /** Vector length; sizes the server's vector(n) column. */
  dims: number;
  /**
   * Tokens per input, [CLS] and [SEP] included: the length the model was
   * trained at (sentence-transformers' max_seq_length), not the tokenizer's
   * model_max_length, which is 512 for all of these.
   */
  maxTokens: number;
  /** Prepended to search queries and to stored text; e5 was trained with both. */
  queryPrefix: string;
  passagePrefix: string;
}

export const EMBEDDING_MODELS = {
  'all-MiniLM-L6-v2': {
    repo: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'fp32',
    pooling: 'mean',
    dims: 384,
    maxTokens: 256,
    queryPrefix: '',
    passagePrefix: '',
  },
  // The multilingual model measured in #3422.
  'paraphrase-multilingual-MiniLM-L12-v2': {
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dtype: 'fp32',
    pooling: 'mean',
    dims: 384,
    maxTokens: 128,
    queryPrefix: '',
    passagePrefix: '',
  },
  'multilingual-e5-small': {
    repo: 'Xenova/multilingual-e5-small',
    dtype: 'fp32',
    pooling: 'mean',
    dims: 384,
    maxTokens: 512,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  // IBM's granite-embedding-97m-multilingual-r2 (ModernBERT, Apache-2.0). Its
  // sentence-transformers config pools the [CLS] token and sets no prompts.
  // It was trained to 8192 tokens; cut at 512 here, because at 8192 one text
  // takes about 10 s and 8 GB on a CPU (attention grows with length squared),
  // and 512 keeps a forward pass the size of e5-small's.
  'granite-embedding-97m-multilingual-r2': {
    repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    dtype: 'fp32',
    pooling: 'cls',
    dims: 384,
    maxTokens: 512,
    queryPrefix: '',
    passagePrefix: '',
  },
} satisfies Record<string, EmbeddingModel>;

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = EMBEDDING_MODELS['all-MiniLM-L6-v2'];

/** The model a CLAUDE_MEM_EMBEDDING_MODEL value names; an unknown name is an error. */
export function resolveEmbeddingModel(name: string): EmbeddingModel {
  const model = (EMBEDDING_MODELS as Record<string, EmbeddingModel>)[name.trim()];
  if (!model) {
    throw new Error(
      `CLAUDE_MEM_EMBEDDING_MODEL="${name}" is not a known embedding model; ` +
      `use one of ${Object.keys(EMBEDDING_MODELS).join(', ')}`,
    );
  }
  return model;
}
