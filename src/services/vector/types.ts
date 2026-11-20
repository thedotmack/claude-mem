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
  /**
   * For an embedder that loads a model before its first embed: whether it has
   * loaded, and a call that starts the load and resolves true once it is ready
   * (false if it fails). An embedder without them is always ready.
   */
  isReady?(): boolean;
  warm?(): Promise<boolean>;
}
