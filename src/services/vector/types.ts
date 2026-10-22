/** Produces unit-length embeddings. Implementations must be deterministic. */
export interface Embedder {
  /** Model identity, persisted per row so a model change is detectable. */
  readonly modelId: string;
  readonly dims: number;
  /**
   * `role` says whether the texts are search queries or stored text; some
   * models (e5) are trained with a different prefix for each. Default passage.
   */
  embed(texts: string[], role?: 'query' | 'passage'): Promise<Float32Array[]>;
}
