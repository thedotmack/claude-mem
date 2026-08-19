/**
 * Vector index contract.
 *
 * Replaces the Chroma sidecar. Embeddings live as rows in claude-mem.db, so a
 * document and its vector are written in ONE transaction by ONE writer — the
 * property the Chroma split could not offer (see #3012: two chroma-mcp writers
 * on one data dir grew the index to 157GB).
 *
 * Deliberately NOT a SQLite extension. bun:sqlite on macOS links Apple's
 * libsqlite3, built with SQLITE_OMIT_LOAD_EXTENSION, so vec0 cannot load at
 * all. A BLOB column plus a scan needs no native storage dependency and is
 * measurably faster than the subprocess round-trip it replaces. The schema is
 * shaped so a vec0 virtual table can be slotted in later behind this same
 * interface if the platform story ever changes.
 */

/** Kinds of document that can be indexed. One table each — see schema.ts. */
export type VectorDocKind = 'observation' | 'summary' | 'prompt';

/** A document to index. `text` is embedded; everything else is provenance. */
export interface VectorDoc {
  /** Stable id, byte-identical to the Chroma id it replaces (e.g. obs_123_fact_4). */
  docId: string;
  /** Row id in the owning table (observations.id, session_summaries.id, ...). */
  sqliteId: number;
  /** Which field of the parent row this document was rendered from. */
  fieldType: string;
  /** Position within a repeated field; null for scalar fields. */
  factIndex: number | null;
  /** The text that gets embedded. */
  text: string;
}

/** A scored hit. `score` is cosine similarity in [-1, 1]; higher is nearer. */
export interface VectorHit {
  /** Which table this hit came from, so callers can route it. */
  kind: VectorDocKind;
  docId: string;
  sqliteId: number;
  fieldType: string;
  factIndex: number | null;
  score: number;
  /** From the parent row; the search layer filters on recency with it. */
  createdAtEpoch: number | null;
}

/** Query scoping. Mirrors ChromaSearchStrategy.buildWhereFilter exactly. */
export interface VectorQuery {
  text: string;
  kinds: VectorDocKind[];
  /** Matches project OR merged_into_project, as the Chroma filter did. */
  project?: string;
  platformSource?: string;
  limit: number;
}

/** Produces unit-length embeddings. Implementations must be deterministic. */
export interface Embedder {
  /** Model identity, persisted per row so a model change is detectable. */
  readonly modelId: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
