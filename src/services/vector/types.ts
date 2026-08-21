/**
 * Vector index contract.
 *
 * Replaces the Chroma sidecar. Embeddings live as rows in claude-mem.db, held
 * to the row they describe by a foreign key with ON DELETE CASCADE, and there
 * is exactly one process writing them. That is the property the Chroma split
 * could not offer — #3012 reports two chroma-mcp writers on one data dir
 * inflating the index by orders of magnitude.
 *
 * It is NOT one transaction with the parent row. Callers index after the row
 * is committed, on a detached promise; the atomicity that does exist is
 * per-parent-row and is described on VectorIndex.upsert.
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
  /**
   * Primary key of the vector row, byte-identical to the Chroma id it replaces.
   * The five forms are obs_<id>_narrative, obs_<id>_text, obs_<id>_fact_<n>,
   * summary_<id>_<field> and prompt_<id>. Both writers — the live path
   * (VectorSync) and the one-time backfill (VectorBackfill) — must mint the
   * same id for the same document; tests/vector/doc-id-parity.test.ts holds
   * them to it.
   */
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

/**
 * Query scoping, unpacked from the Chroma-shaped filter that
 * VectorSearchStrategy.buildWhereFilter still produces.
 */
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
