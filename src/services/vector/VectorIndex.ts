import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Embedder, VectorDoc, VectorDocKind, VectorHit, VectorQuery } from './types.js';
import { VECTOR_TABLES, decodeEmbedding, encodeEmbedding, ensureVectorSchema, hasColumn } from './schema.js';
import { logger } from '../../utils/logger.js';

const BYTES_PER_FLOAT32 = 4;

const PARENT_SAVEPOINT = 'vector_index_parent';

/**
 * Documents handed to the embedder in one call.
 *
 * A batch is padded to its longest member and run as one graph execution, so
 * activation memory grows with the batch. Exported because VectorBackfill sizes
 * its scan against the same ceiling: one source of truth beats two numbers that
 * drift.
 */
export const MAX_EMBED_DOCS = 1024;

/**
 * Text units handed to the embedder in one call.
 *
 * A document cap alone does not bound anything, because what a batch costs is
 * counted in bytes, not in documents. Two batches of identical document count
 * differed by an order of magnitude in resident memory: 1,020 documents of
 * 400KB facts is 340M characters — 680MB of UTF-16 before a vector exists —
 * while 3,060 short ones is under a megabyte. Both caps apply; whichever binds
 * first, binds.
 */
export const MAX_EMBED_CHARS = 4 * 1024 * 1024;

/**
 * How much of the index a caller is asking about — the same axes query() scopes
 * on. Every field optional: an omitted one widens the question rather than
 * failing it.
 */
export interface IndexScope {
  /** Matches project OR merged_into_project, as the Chroma filter did. */
  project?: string;
  platformSource?: string;
}

/** A document that needs embedding, carried with the hash that proved it stale. */
interface StaleDoc {
  doc: VectorDoc;
  hash: string;
}

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
    const stale: StaleDoc[] = [];

    for (const doc of docs) {
      const hash = createHash('sha256').update(doc.text).digest('hex');
      const row = existing.get(doc.docId) as
        | { doc_id: string; content_hash: string; model_id: string }
        | undefined;
      // Re-embed when the text changed OR the model changed underneath us.
      if (!row || row.content_hash !== hash || row.model_id !== this.embedder.modelId) {
        stale.push({ doc, hash });
      }
    }
    if (stale.length === 0) return 0;

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

    let written = 0;
    // Embedding the whole call at once retains every vector until the last one
    // is written. Slicing releases each slice's vectors before the next is
    // produced; slices never straddle a parent, so the per-parent atomicity
    // below is unaffected by where they fall.
    for (const slice of sliceUnderCaps(stale)) {
      const vectors = await this.embedInCappedCalls(slice.map((entry) => entry.doc.text));

      const byParent = new Map<number, Array<{ entry: StaleDoc; vector: Float32Array }>>();
      for (let i = 0; i < slice.length; i++) {
        const entry = slice[i];
        const bucket = byParent.get(entry.doc.sqliteId);
        if (bucket) bucket.push({ entry, vector: vectors[i] });
        else byParent.set(entry.doc.sqliteId, [{ entry, vector: vectors[i] }]);
      }

      for (const [sqliteId, entries] of byParent) {
        const committed = this.writeParent(kind, sqliteId, () => {
          for (const { entry, vector } of entries) {
            write.run(
              entry.doc.docId,
              entry.doc.sqliteId,
              entry.doc.fieldType,
              entry.doc.factIndex,
              entry.hash,
              this.embedder.modelId,
              this.embedder.dims,
              encodeEmbedding(vector),
            );
          }
        });
        if (committed) written += entries.length;
      }
    }
    return written;
  }

  /**
   * Embed `texts` without ever handing the embedder more than the caps allow.
   *
   * The caller's array length is whatever a row set happened to render to,
   * which is not a size to hand a model unchecked — and a single parent row can
   * exceed both caps on its own, which is why the split happens here rather
   * than only where slices are cut. Always advances by at least one document,
   * so one document larger than the whole character cap still makes progress.
   */
  private async embedInCappedCalls(texts: string[]): Promise<Float32Array[]> {
    if (texts.length <= MAX_EMBED_DOCS && totalChars(texts) <= MAX_EMBED_CHARS) {
      return this.embedder.embed(texts);
    }
    const vectors: Float32Array[] = [];
    let start = 0;
    while (start < texts.length) {
      let end = start;
      let chars = 0;
      while (
        end < texts.length
        && (end === start
          || (end - start < MAX_EMBED_DOCS && chars + texts[end].length <= MAX_EMBED_CHARS))
      ) {
        chars += texts[end].length;
        end++;
      }
      const chunk = await this.embedder.embed(texts.slice(start, end));
      for (const vector of chunk) vectors.push(vector);
      start = end;
    }
    return vectors;
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
   * The WHERE that decides which vectors are in scope.
   *
   * Extracted so query() and countIndexed() cannot answer about different sets
   * of rows. They did: countIndexed was an unscoped COUNT(*) while query()
   * filtered on project and model, so "is this scope populated" was answered
   * from a different population than the one the search would read.
   */
  private scopeSql(kind: VectorDocKind, scope: IndexScope): { where: string; params: (string | number)[] } {
    const spec = VECTOR_TABLES[kind];
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (scope.project) {
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
        params.push(scope.project, scope.project);
      } else {
        where.push(`${spec.projectExpr} = ?`);
        params.push(scope.project);
      }
    }

    if (scope.platformSource && spec.platformExpr && spec.platformRequires
        && hasColumn(this.db, ...spec.platformRequires)) {
      where.push(`${spec.platformExpr} = ?`);
      params.push(scope.platformSource);
    }

    // A model change invalidates comparability; never mix vector spaces.
    where.push('v.model_id = ?');
    params.push(this.embedder.modelId);

    return { where: where.join(' AND '), params };
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
      const { where, params } = this.scopeSql(kind, q);

      const rows = this.db.prepare(`
        SELECT v.doc_id, v.sqlite_id, v.field_type, v.fact_index, v.embedding,
               p.created_at_epoch AS created_at_epoch
        FROM ${spec.table} v
        ${spec.joinSql}
        WHERE ${where}
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

  /**
   * Vectors this index holds for `kind`, within the scope a search would read.
   *
   * The scope argument is what makes the answer usable as "is this scope
   * populated". An unscoped COUNT(*) answers a different question: a project
   * with 350 rows and nothing indexed reported a non-zero count because
   * ANOTHER project's vectors existed, and after a model change every vector
   * written under the old model_id still counted despite being unreadable by
   * query(). The model_id filter therefore applies always, project and
   * platform only when asked for.
   *
   * The JOIN to the parent table is added only for a scoped count, since that
   * is the only thing it is there to reach. It is not free of meaning: the
   * prompt join is an INNER one, so a scoped count reports vectors REACHABLE
   * in that scope while an unscoped count reports what the table holds.
   */
  countIndexed(kind: VectorDocKind, scope: IndexScope = {}): number {
    const spec = VECTOR_TABLES[kind];
    const scoped = Boolean(scope.project) || Boolean(scope.platformSource);
    if (scoped && !this.tableExists(spec.parent)) return 0;
    const { where, params } = this.scopeSql(kind, scope);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM ${spec.table} v
      ${scoped ? spec.joinSql : ''}
      WHERE ${where}
    `).get(...params) as { n: number };
    return row.n;
  }
}

function totalChars(texts: string[]): number {
  let chars = 0;
  for (const text of texts) chars += text.length;
  return chars;
}

function groupChars(group: StaleDoc[]): number {
  let chars = 0;
  for (const entry of group) chars += entry.doc.text.length;
  return chars;
}

/**
 * Cut a batch into slices that stay under both caps.
 *
 * Parent rows are the unit of atomicity, so a slice never straddles one: a cut
 * through the middle of a row would put half its documents in a savepoint that
 * commits and half in one that might not. Grouping is by id rather than by
 * adjacency, so a caller that interleaves two rows' documents still gets each
 * row written whole. A parent wider than the caps becomes a slice of its own —
 * embedInCappedCalls is what keeps THAT from reaching the embedder in one piece.
 */
function sliceUnderCaps(stale: StaleDoc[]): StaleDoc[][] {
  const groups = new Map<number, StaleDoc[]>();
  for (const entry of stale) {
    const bucket = groups.get(entry.doc.sqliteId);
    if (bucket) bucket.push(entry);
    else groups.set(entry.doc.sqliteId, [entry]);
  }

  const slices: StaleDoc[][] = [];
  let current: StaleDoc[] = [];
  let chars = 0;

  for (const group of groups.values()) {
    const cost = groupChars(group);
    if (current.length > 0
        && (current.length + group.length > MAX_EMBED_DOCS
          || chars + cost > MAX_EMBED_CHARS)) {
      slices.push(current);
      current = [];
      chars = 0;
    }
    for (const entry of group) current.push(entry);
    chars += cost;
  }
  if (current.length > 0) slices.push(current);
  return slices;
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
