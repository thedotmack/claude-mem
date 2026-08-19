import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Embedder, VectorDoc, VectorDocKind, VectorHit, VectorQuery } from './types.js';
import { VECTOR_TABLES, decodeEmbedding, encodeEmbedding, ensureVectorSchema } from './schema.js';

interface CandidateRow {
  doc_id: string;
  sqlite_id: number;
  field_type: string;
  fact_index: number | null;
  embedding: Uint8Array;
}

/**
 * In-file vector index. Writes go through the caller's transaction, so a
 * document and its embedding commit together or not at all.
 */
export class VectorIndex {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {
    ensureVectorSchema(db);
  }

  /**
   * Insert or update documents.
   *
   * Embedding is the expensive step, so unchanged text is skipped: content_hash
   * is compared first and only genuinely new or edited rows are embedded. That
   * makes a re-sync cheap and makes this safe to call unconditionally.
   *
   * NOT wrapped in its own transaction — the caller owns the transaction so the
   * vector lands atomically with the row it describes. That is the entire point
   * of moving off the sidecar.
   */
  async upsert(kind: VectorDocKind, docs: VectorDoc[]): Promise<number> {
    if (docs.length === 0) return 0;
    const { table } = VECTOR_TABLES[kind];

    const existing = this.db.prepare(
      `SELECT doc_id, content_hash, model_id FROM ${table} WHERE doc_id = ?`,
    );
    const stale: VectorDoc[] = [];
    const hashes = new Map<string, string>();

    for (const doc of docs) {
      const hash = createHash('sha256').update(doc.text).digest('hex');
      hashes.set(doc.docId, hash);
      const row = existing.get(doc.docId) as
        | { doc_id: string; content_hash: string; model_id: string }
        | undefined;
      // Re-embed when the text changed OR the model changed underneath us.
      if (!row || row.content_hash !== hash || row.model_id !== this.embedder.modelId) {
        stale.push(doc);
      }
    }
    if (stale.length === 0) return 0;

    const vectors = await this.embedder.embed(stale.map((d) => d.text));

    const write = this.db.prepare(`
      INSERT INTO ${table}
        (doc_id, sqlite_id, field_type, fact_index, content_hash, model_id, dims, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        sqlite_id = excluded.sqlite_id,
        field_type = excluded.field_type,
        fact_index = excluded.fact_index,
        content_hash = excluded.content_hash,
        model_id = excluded.model_id,
        dims = excluded.dims,
        embedding = excluded.embedding
    `);

    for (let i = 0; i < stale.length; i++) {
      const doc = stale[i];
      write.run(
        doc.docId,
        doc.sqliteId,
        doc.fieldType,
        doc.factIndex,
        hashes.get(doc.docId)!,
        this.embedder.modelId,
        this.embedder.dims,
        encodeEmbedding(vectors[i]),
      );
    }
    return stale.length;
  }

  /**
   * Nearest neighbours, scoped exactly as the Chroma filter was.
   *
   * Scoping happens in SQL and scoring in JS. Project scope is what keeps the
   * scan small: it is a JOIN predicate, not a post-filter, so a query touches
   * one project's slice rather than the whole corpus.
   */
  async query(q: VectorQuery): Promise<VectorHit[]> {
    const [probe] = await this.embedder.embed([q.text]);
    const hits: VectorHit[] = [];

    for (const kind of q.kinds) {
      const { table, parent } = VECTOR_TABLES[kind];
      const where: string[] = [];
      const params: (string | number)[] = [];

      if (q.project) {
        // Mirrors buildWhereFilter's $or: [{project}, {merged_into_project}]
        where.push(`(p.project = ? OR p.merged_into_project = ?)`);
        params.push(q.project, q.project);
      }
      if (q.platformSource) {
        where.push(`p.platform_source = ?`);
        params.push(q.platformSource);
      }
      // A model change invalidates comparability; never mix vector spaces.
      where.push(`v.model_id = ?`);
      params.push(this.embedder.modelId);

      const rows = this.db.prepare(`
        SELECT v.doc_id, v.sqlite_id, v.field_type, v.fact_index, v.embedding
        FROM ${table} v
        JOIN ${parent} p ON p.id = v.sqlite_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `).all(...params) as CandidateRow[];

      for (const row of rows) {
        hits.push({
          docId: row.doc_id,
          sqliteId: row.sqlite_id,
          fieldType: row.field_type,
          factIndex: row.fact_index,
          score: dot(probe, decodeEmbedding(row.embedding)),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, q.limit);
  }

  /** Vectors cascade with their parent row; this is for explicit removal. */
  deleteByParent(kind: VectorDocKind, sqliteId: number): void {
    const { table } = VECTOR_TABLES[kind];
    this.db.prepare(`DELETE FROM ${table} WHERE sqlite_id = ?`).run(sqliteId);
  }

  countIndexed(kind: VectorDocKind): number {
    const { table } = VECTOR_TABLES[kind];
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }
}

/**
 * Cosine similarity. Embeddings are unit-length by contract (Embedder
 * normalizes), so the dot product IS the cosine and the norms drop out.
 */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
