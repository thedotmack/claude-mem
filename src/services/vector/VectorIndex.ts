import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Embedder, VectorDoc, VectorDocKind, VectorHit, VectorQuery } from './types.js';
import { VECTOR_TABLES, decodeEmbedding, encodeEmbedding, ensureVectorSchema, hasColumn } from './schema.js';
import { logger } from '../../utils/logger.js';

const BYTES_PER_FLOAT32 = 4;

const PARENT_SAVEPOINT = 'vector_index_parent';

interface CandidateRow {
  doc_id: string;
  sqlite_id: number;
  field_type: string;
  fact_index: number | null;
  embedding: Uint8Array;
  created_at_epoch: number | null;
}

/**
 * In-file vector index. Vectors are rows in the same database file as the
 * content they describe, so there is no second store to fall out of step with
 * and no cross-store write to reconcile.
 */
export class VectorIndex {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {
    ensureVectorSchema(db);
  }

  /** Identity of the vector space currently being written. */
  get modelId(): string {
    return this.embedder.modelId;
  }

  /**
   * Insert or update documents.
   *
   * Embedding is the expensive step, so unchanged text is skipped: content_hash
   * is compared first and only genuinely new or edited rows are embedded. That
   * makes a re-sync cheap and makes this safe to call unconditionally.
   *
   * Atomicity is per parent row, not per call and not shared with the parent
   * row's own insert. Every caller indexes AFTER the row is committed, on a
   * detached promise, so there is no enclosing transaction to join. What this
   * does guarantee is that one row's documents land together: each parent's
   * writes run inside a SAVEPOINT, so a row whose parent vanished between the
   * embed and the write is rolled back and skipped instead of aborting the
   * whole batch. Vectors are removed with their parent by ON DELETE CASCADE.
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

    const byParent = new Map<number, Array<{ doc: VectorDoc; vector: Float32Array }>>();
    for (let i = 0; i < stale.length; i++) {
      const doc = stale[i];
      const bucket = byParent.get(doc.sqliteId);
      if (bucket) bucket.push({ doc, vector: vectors[i] });
      else byParent.set(doc.sqliteId, [{ doc, vector: vectors[i] }]);
    }

    let written = 0;
    for (const [sqliteId, entries] of byParent) {
      const committed = this.writeParent(kind, sqliteId, () => {
        for (const { doc, vector } of entries) {
          write.run(
            doc.docId,
            doc.sqliteId,
            doc.fieldType,
            doc.factIndex,
            hashes.get(doc.docId)!,
            this.embedder.modelId,
            this.embedder.dims,
            encodeEmbedding(vector),
          );
        }
      });
      if (committed) written += entries.length;
    }
    return written;
  }

  private writeParent(kind: VectorDocKind, sqliteId: number, run: () => void): boolean {
    this.db.run(`SAVEPOINT ${PARENT_SAVEPOINT}`);
    try {
      run();
    } catch (error) {
      this.db.run(`ROLLBACK TO ${PARENT_SAVEPOINT}`);
      this.db.run(`RELEASE ${PARENT_SAVEPOINT}`);
      if (isMissingParent(error)) {
        logger.warn('VECTOR_INDEX', 'Skipped vanished parent row', { kind, sqliteId });
        return false;
      }
      throw error;
    }
    this.db.run(`RELEASE ${PARENT_SAVEPOINT}`);
    return true;
  }

  /**
   * Nearest neighbours, scoped exactly as the Chroma filter was.
   *
   * Scoping happens in SQL and scoring in JS. Project scope is what keeps the
   * scan small: it is a JOIN predicate, not a post-filter, so a query touches
   * one project's slice rather than the whole corpus. That depends on
   * idx_observations_project existing (it does — SessionStore creates it):
   * with it, EXPLAIN QUERY PLAN drives from observations by project and looks
   * each vector up by sqlite_id; without it, SQLite drives from the model_id
   * index instead and reads every row in the table.
   */
  async query(q: VectorQuery): Promise<VectorHit[]> {
    const [probe] = await this.embedder.embed([q.text]);
    const hits: VectorHit[] = [];

    for (const kind of q.kinds) {
      const spec = VECTOR_TABLES[kind];
      if (!this.tableExists(spec.parent)) continue;
      const where: string[] = [];
      const params: (string | number)[] = [];

      if (q.project) {
        // Mirrors buildWhereFilter's $or: [{project}, {merged_into_project}].
        // merged_into_project only exists once its ALTER TABLE migration has
        // run, so an unmigrated store scopes on project alone rather than
        // erroring out and failing search closed.
        const merged =
          spec.mergedExpr && spec.mergedRequires && hasColumn(this.db, ...spec.mergedRequires)
            ? spec.mergedExpr
            : null;
        if (merged) {
          where.push(`(${spec.projectExpr} = ? OR ${merged} = ?)`);
          params.push(q.project, q.project);
        } else {
          where.push(`${spec.projectExpr} = ?`);
          params.push(q.project);
        }
      }

      if (q.platformSource && spec.platformExpr && spec.platformRequires
          && hasColumn(this.db, ...spec.platformRequires)) {
        where.push(`${spec.platformExpr} = ?`);
        params.push(q.platformSource);
      }

      // A model change invalidates comparability; never mix vector spaces.
      where.push('v.model_id = ?');
      params.push(this.embedder.modelId);

      const rows = this.db.prepare(`
        SELECT v.doc_id, v.sqlite_id, v.field_type, v.fact_index, v.embedding,
               p.created_at_epoch AS created_at_epoch
        FROM ${spec.table} v
        ${spec.joinSql}
        WHERE ${where.join(' AND ')}
      `).all(...params) as CandidateRow[];

      const expectedBytes = probe.length * BYTES_PER_FLOAT32;
      let skipped = 0;
      for (const row of rows) {
        if (!row.embedding || row.embedding.byteLength !== expectedBytes) {
          skipped++;
          continue;
        }
        const score = dot(probe, decodeEmbedding(row.embedding));
        if (!Number.isFinite(score)) {
          skipped++;
          continue;
        }
        hits.push({
          kind,
          docId: row.doc_id,
          sqliteId: row.sqlite_id,
          fieldType: row.field_type,
          factIndex: row.fact_index,
          createdAtEpoch: row.created_at_epoch,
          score,
        });
      }
      if (skipped > 0) {
        logger.warn('VECTOR_INDEX', 'Skipped malformed embeddings', {
          kind, skipped, expectedBytes,
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

  private tableExists(table: string): boolean {
    const row = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(table) as { name: string } | undefined;
    return Boolean(row);
  }

  countIndexed(kind: VectorDocKind): number {
    const { table } = VECTOR_TABLES[kind];
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }
}

/**
 * A write that failed because the parent row is gone — the row was deleted
 * between selecting it and writing its vector.
 */
function isMissingParent(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code) return code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
  return error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);
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
