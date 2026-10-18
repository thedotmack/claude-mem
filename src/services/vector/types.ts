/** Produces unit-length embeddings. Implementations must be deterministic. */
export interface Embedder {
  /** Model identity, persisted per row so a model change is detectable. */
  readonly modelId: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
