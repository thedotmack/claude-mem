import type { Database } from 'bun:sqlite';
import { VectorIndex } from './VectorIndex.js';
import { VECTOR_TABLES, hasColumn } from './schema.js';
import type { VectorDoc, VectorDocKind } from './types.js';
import { logger } from '../../utils/logger.js';

/** Rows per pass. Bounded so a large store never holds the loop for long. */
const BATCH_SIZE = 200;

export interface BackfillProgress {
  kind: VectorDocKind;
  processed: number;
  embedded: number;
  remaining: number;
}

/**
 * One-time re-embed of an existing corpus.
 *
 * Existing installs have their vectors in Chroma. They are not migrated: the
 * #3012 recovery showed only ~1,000 of 141,476 vectors were recoverable from
 * chroma.sqlite3, and SQLite is the source of truth anyway, so the documents
 * are simply re-embedded from it. Measured cost is ~4 minutes for a
 * 141,476-document store on slow hardware.
 *
 * Resumable with no bookkeeping. "What still needs embedding" is a LEFT JOIN,
 * not a bookmark, so an interrupted run resumes by asking the same question
 * again. That is the direct payoff of vectors living in the same database:
 * chroma-sync-state.json existed only to answer this, and it is exactly the
 * file #3012 victims had to delete by hand before a re-embed would proceed.
 */
export class VectorBackfill {
  constructor(
    private readonly db: Database,
    private readonly index: VectorIndex,
  ) {}

  /** Rows of this kind that have no vector for the current model. */
  private pendingCount(kind: VectorDocKind, modelId: string): number {
    const { table, parent } = VECTOR_TABLES[kind];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM ${parent} p
      WHERE NOT EXISTS (
        SELECT 1 FROM ${table} v WHERE v.sqlite_id = p.id AND v.model_id = ?
      )
    `).get(modelId) as { n: number };
    return row.n;
  }

  private nextBatch(kind: VectorDocKind, modelId: string): VectorDoc[] {
    const { table, parent } = VECTOR_TABLES[kind];
    const cols = this.selectColumns(kind);
    const rows = this.db.prepare(`
      SELECT p.id AS id, ${cols} FROM ${parent} p
      WHERE NOT EXISTS (
        SELECT 1 FROM ${table} v WHERE v.sqlite_id = p.id AND v.model_id = ?
      )
      ORDER BY p.id
      LIMIT ${BATCH_SIZE}
    `).all(modelId) as Record<string, unknown>[];
    return rows.flatMap((row) => this.toDocs(kind, row));
  }

  private selectColumns(kind: VectorDocKind): string {
    if (kind === 'observation') return 'p.narrative AS narrative, p.facts AS facts';
    if (kind === 'summary') {
      return ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes']
        .filter((c) => hasColumn(this.db, 'session_summaries', c))
        .map((c) => `p.${c} AS ${c}`)
        .join(', ') || `NULL AS request`;
    }
    return 'p.prompt_text AS prompt_text';
  }

  private toDocs(kind: VectorDocKind, row: Record<string, unknown>): VectorDoc[] {
    const id = Number(row.id);
    const docs: VectorDoc[] = [];

    if (kind === 'observation') {
      if (row.narrative) {
        docs.push({ docId: `obs_${id}_narrative`, sqliteId: id, fieldType: 'narrative', factIndex: null, text: String(row.narrative) });
      }
      // facts is a JSON array column; a malformed value must not stall the
      // whole backfill, so it degrades to "this row has no fact documents".
      let facts: unknown[] = [];
      try { facts = row.facts ? JSON.parse(String(row.facts)) : []; } catch { facts = []; }
      facts.forEach((fact, i) => {
        if (typeof fact === 'string' && fact.length > 0) {
          docs.push({ docId: `obs_${id}_fact_${i}`, sqliteId: id, fieldType: 'fact', factIndex: i, text: fact });
        }
      });
      return docs;
    }

    if (kind === 'summary') {
      for (const [field, value] of Object.entries(row)) {
        if (field === 'id' || !value) continue;
        docs.push({ docId: `sum_${id}_${field}`, sqliteId: id, fieldType: field, factIndex: null, text: String(value) });
      }
      return docs;
    }

    if (row.prompt_text) {
      docs.push({ docId: `pr_${id}`, sqliteId: id, fieldType: 'prompt_text', factIndex: null, text: String(row.prompt_text) });
    }
    return docs;
  }

  /**
   * Embed one batch per kind. Returns per-kind progress so a caller can drive
   * this on a timer and stop when everything reports remaining === 0.
   *
   * Deliberately one batch per call rather than a loop to completion: the
   * worker stays responsive, and an install that quits mid-migration simply
   * resumes on next boot instead of losing the pass.
   */
  async runBatch(kinds: VectorDocKind[] = ['observation', 'summary', 'prompt']): Promise<BackfillProgress[]> {
    const modelId = this.index.modelId;
    const progress: BackfillProgress[] = [];

    for (const kind of kinds) {
      const { parent } = VECTOR_TABLES[kind];
      if (!this.tableExists(parent)) continue;

      const docs = this.nextBatch(kind, modelId);
      let embedded = 0;
      if (docs.length > 0) {
        embedded = await this.index.upsert(kind, docs);
      }
      const remaining = this.pendingCount(kind, modelId);
      progress.push({ kind, processed: docs.length, embedded, remaining });

      if (docs.length > 0) {
        logger.info('VECTOR_INDEX', 'Backfill batch', { kind, documents: docs.length, embedded, remaining });
      }
    }
    return progress;
  }

  private tableExists(table: string): boolean {
    const row = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(table) as { name: string } | undefined;
    return Boolean(row);
  }

  /** True when every kind is fully embedded for the current model. */
  isComplete(modelId: string): boolean {
    return (['observation', 'summary', 'prompt'] as VectorDocKind[])
      .filter((k) => this.tableExists(VECTOR_TABLES[k].parent))
      .every((k) => this.pendingCount(k, modelId) === 0);
  }
}
