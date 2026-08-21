import type { Database } from 'bun:sqlite';
import { MAX_EMBED_CHARS, MAX_EMBED_DOCS, VectorIndex } from './VectorIndex.js';
import { VECTOR_TABLES, hasColumn } from './schema.js';
import type { VectorDoc, VectorDocKind } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Rows SELECTed per pass — an upper bound, not a count of rows processed. A
 * pass admits fewer whenever a document or character budget bites first.
 * Bounded so a large store never holds the loop for long.
 */
const BATCH_SIZE = 200;

/**
 * What a pass may accumulate, in documents AND in characters.
 *
 * A row renders to narrative + text + one document per fact, so BATCH_SIZE
 * bounds rows but not documents — and a document count bounds nothing at all,
 * because what a pass costs is counted in bytes. 1,020 documents of 400KB
 * facts is 340M characters; 3,060 short ones is under a megabyte. Both apply,
 * and the scan stops at whichever binds first.
 *
 * Rows are still admitted whole, because a parent row is the unit the index
 * writes atomically and a row split across passes would be invisible to the
 * NOT EXISTS skip on resume. A pass therefore stops admitting rows once a
 * budget is reached, having taken the row that crossed it — an overshoot of at
 * most one row. What a wide row no longer buys is an oversized embedder call:
 * VectorIndex re-slices whatever it is handed under these same caps, which is
 * why they are imported here rather than restated.
 */
const MAX_DOCS_PER_BATCH = MAX_EMBED_DOCS;
const MAX_CHARS_PER_BATCH = MAX_EMBED_CHARS;

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
 * #3012 recovery reports that almost nothing was recoverable from
 * chroma.sqlite3, and SQLite is the source of truth anyway, so the documents
 * are simply re-embedded from it. How long that takes is a function of corpus
 * size and hardware; it runs in the background and search stays usable
 * throughout, so it is not a startup cost the user waits on.
 *
 * Resumable with no persisted bookkeeping. An interrupted run resumes by asking
 * the same question of the same database on next boot; nothing to reset by hand.
 * That is the direct payoff of vectors living in the same database:
 * chroma-sync-state.json existed only to answer this, and it is exactly the
 * file #3012 victims had to delete by hand before a re-embed would proceed.
 *
 * The pass is a KEYSET SCAN, not a set difference, and that distinction is
 * load-bearing. "Rows with no vector" asks a ROW-level question, but progress
 * is only ever recordable at DOCUMENT granularity — one vector row per emitted
 * document. A parent row that emits ZERO documents can therefore never satisfy
 * it, and with ORDER BY id LIMIT n the lowest-id doc-less rows are re-selected
 * in every batch, so the window never advances and the caller's re-arm timer
 * spins forever. Doc-less rows are ordinary: an observation with only
 * title+concepts (parser.ts skips only when all four content fields are empty),
 * a session_summaries row with all six text fields NULL, a user_prompts row
 * with ''. Carrying a cursor makes "examined" representable independently of
 * "embedded", so those rows are passed over exactly once and the pass ends.
 */
export class VectorBackfill {
  /**
   * Highest parent id already examined, per kind. Advances monotonically, which
   * is what lets a doc-less row be passed over instead of re-selected forever.
   */
  private readonly cursor = new Map<VectorDocKind, number>();
  /** Kinds whose scan has reached the end of the table. */
  private readonly finished = new Set<VectorDocKind>();

  constructor(
    private readonly db: Database,
    private readonly index: VectorIndex,
  ) {}

  /**
   * Rows of this kind still AHEAD of the cursor that have no vector.
   *
   * The NOT EXISTS clause stays because it is a cheap skip for rows a previous
   * process already embedded; the cursor is what guarantees termination.
   */
  private pendingCount(kind: VectorDocKind, modelId: string): number {
    if (this.finished.has(kind)) return 0;
    const { table, parent } = VECTOR_TABLES[kind];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM ${parent} p
      WHERE p.id > ?
        AND NOT EXISTS (
          SELECT 1 FROM ${table} v WHERE v.sqlite_id = p.id AND v.model_id = ?
        )
    `).get(this.cursorFor(kind), modelId) as { n: number };
    return row.n;
  }

  private cursorFor(kind: VectorDocKind): number {
    return this.cursor.get(kind) ?? 0;
  }

  /**
   * The next pass's documents, and the highest row id it examined.
   *
   * Rows are pulled ONE AT A TIME. .all() materialised every selected row —
   * facts blobs and all — before the cap could look at any of them, so the cap
   * could only ever choose what to do with allocations that had already
   * happened: a batch strictly under the 1,024-document cap still resident-set
   * a gigabyte. Iterating means one row's content is live at a time and the
   * scan stops READING, not just stops admitting, the moment a budget is spent.
   *
   * Rows arrive in id order, so the high-water mark is the last row ADMITTED —
   * not the last row selected. Rows the scan never reached stay ahead of the
   * cursor for the next pass.
   */
  private nextBatch(kind: VectorDocKind, modelId: string): { docs: VectorDoc[]; lastId: number | null } {
    const { table, parent } = VECTOR_TABLES[kind];
    const cols = this.selectColumns(kind);
    const rows = this.db.prepare(`
      SELECT p.id AS id, ${cols} FROM ${parent} p
      WHERE p.id > ?
        AND NOT EXISTS (
          SELECT 1 FROM ${table} v WHERE v.sqlite_id = p.id AND v.model_id = ?
        )
      ORDER BY p.id
      LIMIT ${BATCH_SIZE}
    `).iterate(this.cursorFor(kind), modelId) as IterableIterator<Record<string, unknown>>;

    const docs: VectorDoc[] = [];
    let chars = 0;
    let lastId: number | null = null;
    for (const row of rows) {
      // Checked BEFORE the row is rendered, so a full pass never parses a
      // facts blob it is not going to admit — and never holds it either.
      if (docs.length >= MAX_DOCS_PER_BATCH || chars >= MAX_CHARS_PER_BATCH) break;
      for (const doc of this.toDocs(kind, row)) {
        docs.push(doc);
        chars += doc.text.length;
      }
      lastId = Number(row.id);
    }
    return { docs, lastId };
  }

  /**
   * Columns are probed rather than assumed. observations.text is in the BASE
   * table while narrative/facts only arrive at schema v8, so BOTH halves can be
   * absent depending on how old the store is, and naming a missing column is a
   * hard SQL error that would abort the whole migration.
   */
  private selectColumns(kind: VectorDocKind): string {
    if (kind === 'observation') {
      return ['narrative', 'text', 'facts']
        .filter((c) => hasColumn(this.db, 'observations', c))
        .map((c) => `p.${c} AS ${c}`)
        .join(', ') || `NULL AS narrative`;
    }
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
      // The flat pre-v8 field. It is the only content an observation captured
      // before schema v8 has, so dropping it makes most of an upgrading
      // install's corpus unsearchable. Ordered after narrative, as ChromaSync
      // emitted it.
      if (row.text) {
        docs.push({ docId: `obs_${id}_text`, sqliteId: id, fieldType: 'text', factIndex: null, text: String(row.text) });
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
        docs.push({ docId: `summary_${id}_${field}`, sqliteId: id, fieldType: field, factIndex: null, text: String(value) });
      }
      return docs;
    }

    if (row.prompt_text) {
      docs.push({ docId: `prompt_${id}`, sqliteId: id, fieldType: 'prompt_text', factIndex: null, text: String(row.prompt_text) });
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

      const { docs, lastId } = this.nextBatch(kind, modelId);
      let embedded = 0;
      if (docs.length > 0) {
        embedded = await this.index.upsert(kind, docs);
      }

      if (lastId === null) {
        // The scan ran off the end of the table: this kind is done. Any row
        // still without a vector is one that renders to no document at all.
        this.finished.add(kind);
      } else {
        // Advanced only after a successful upsert, so a throwing batch leaves
        // the cursor where it was and the caller can retry the same window.
        this.cursor.set(kind, lastId);
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

  /**
   * True when every kind's scan has nothing left ahead of its cursor.
   *
   * Not "every row has a vector" — that can never become true in the presence
   * of a doc-less row, and asserting it is what wedged the caller's timer.
   */
  isComplete(modelId: string): boolean {
    return (['observation', 'summary', 'prompt'] as VectorDocKind[])
      .filter((k) => this.tableExists(VECTOR_TABLES[k].parent))
      .every((k) => this.pendingCount(k, modelId) === 0);
  }
}
