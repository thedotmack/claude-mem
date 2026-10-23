/** Produces unit-length embeddings. Implementations must be deterministic. */
export interface Embedder {
  /** Model identity, persisted per row so a model change is detectable. */
  readonly modelId: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * For an embedder that loads a model before its first embed: whether it has
   * loaded, and a call that starts the load and resolves true once it is ready
   * (false if it fails). An embedder without them is always ready.
   */
  isReady?(): boolean;
  warm?(): Promise<boolean>;
}
