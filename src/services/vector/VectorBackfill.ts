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
 * What a pass may EXAMINE, in documents AND in characters.
 *
 * A row renders to narrative + text + one document per fact, so BATCH_SIZE
 * bounds rows but not documents — and a document count bounds nothing at all,
 * because what a pass costs is counted in bytes. 1,020 documents of 400KB
 * facts is 340M characters; 3,060 short ones is under a megabyte. Both apply,
 * and the scan stops at whichever binds first.
 *
 * This is a work budget, NOT a memory bound: it is checked between rows, so a
 * single row larger than either figure is still taken whole. What bounds
 * memory is the slice (see SliceBuffer) and the piece (see FACTS_CHUNK_CHARS)
 * — the pass reads, renders, embeds and writes a wide row a slice at a time
 * rather than materialising it.
 */
const MAX_DOCS_PER_BATCH = MAX_EMBED_DOCS;
const MAX_CHARS_PER_BATCH = MAX_EMBED_CHARS;

/**
 * Characters of a JSON array column read in one piece.
 *
 * Sized to the slice, so the source text this process holds while rendering a
 * row is the same order as the documents that come out of it. It does not make
 * a huge row free: SQLite materialises the column value it is slicing, and that
 * is the floor for a column this size — measured on a 100MB facts column, peak
 * RSS of a run is 190-200MB against 385-420MB when the row was rendered whole
 * (a fresh process, 22MB before it opened the store). What
 * the piece removes is a JS copy of the column and a live copy of every
 * document in it. This is the path a column too wide for the eager read takes;
 * an ordinary row never reaches it, having arrived whole already.
 */
const FACTS_CHUNK_CHARS = MAX_EMBED_CHARS;

/**
 * Characters of any one content column taken in a row's single eager read.
 *
 * This read is SPECULATIVE — every column of every row, whether or not it turns
 * out to be small — so its width is what a wrong guess costs, not what a right
 * one is allowed to be. Far below the slice for that reason: at 64Ki a column
 * that overshoots wastes a 64KB read before falling back to the path it would
 * have taken anyway, where at slice width the same overshoot wasted 4MB and
 * measurably raised the peak of a 100MB row. Wide enough that ordinary content
 * never overshoots: the widest thing an observation carries is its facts array,
 * a few KB of short strings.
 *
 * The read asks for one character MORE than this, so a value that comes back at
 * the full width is known to have been cut rather than merely to have ended
 * there.
 */
const EAGER_READ_CHARS = 64 * 1024;

/**
 * Content columns per kind, in the order their documents are emitted.
 *
 * A row's columns are read TOGETHER, in one statement, each cut at
 * EAGER_READ_CHARS. Reading them one query at a time instead bounded the same
 * bytes but charged every row a primary-key lookup per column plus a schema
 * probe — a cost only the rare wide row should pay, levied on the ordinary
 * narrow ones that are almost all of a corpus. Measured on 20,000 rows /
 * 120,000 documents with the embedder stubbed out, the two trees interleaved on
 * one machine, median of six runs: 12.9s per column against 11.9s for this, and
 * 6.7s against 5.9s of user CPU. A column that did come back cut is then read
 * on its own, which is the wide-row path unchanged — it is just no longer the
 * path every row takes.
 */
const SCALAR_COLUMNS: Record<VectorDocKind, { table: string; columns: string[] }> = {
  observation: { table: 'observations', columns: ['narrative', 'text'] },
  summary: {
    table: 'session_summaries',
    columns: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
  },
  prompt: { table: 'user_prompts', columns: ['prompt_text'] },
};

export interface BackfillProgress {
  kind: VectorDocKind;
  processed: number;
  embedded: number;
  remaining: number;
}

interface PassResult {
  processed: number;
  embedded: number;
  lastId: number | null;
}

/** This store's shape for one kind, settled once per pass rather than per row. */
interface RowPlan {
  table: string;
  /** Scalar content columns this store actually has, in emit order. */
  columns: string[];
  /** Whether fact documents are renderable — observations, with the column. */
  facts: boolean;
  /** Reads one row's content: every column, cut, in a single statement. */
  sql: string;
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
   * Ids of the next rows to examine — ids ONLY, never their content.
   *
   * Selecting content here is what made a pass cost whatever the widest row in
   * it happened to weigh: .all() materialised every selected row, facts blobs
   * and all, before any cap could look at them, and iterating instead still
   * left the crossing row rendered whole. Ids are 8 bytes each, so this list is
   * free, and each row's content is then read, embedded and released one slice
   * at a time.
   */
  private pendingIds(kind: VectorDocKind, modelId: string): number[] {
    const { table, parent } = VECTOR_TABLES[kind];
    const rows = this.db.prepare(`
      SELECT p.id AS id FROM ${parent} p
      WHERE p.id > ?
        AND NOT EXISTS (
          SELECT 1 FROM ${table} v WHERE v.sqlite_id = p.id AND v.model_id = ?
        )
      ORDER BY p.id
      LIMIT ${BATCH_SIZE}
    `).all(this.cursorFor(kind), modelId) as { id: number }[];
    return rows.map((row) => Number(row.id));
  }

  /**
   * One pass over one kind: render, embed and write until a budget is spent.
   *
   * Rows arrive in id order, so the high-water mark is the last row ADMITTED —
   * not the last row selected. Rows the scan never reached stay ahead of the
   * cursor for the next pass.
   *
   * A row is admitted whole even when it crosses a budget, because a parent row
   * is the unit the index writes atomically and a row split across passes would
   * be invisible to the NOT EXISTS skip on resume. Admitting it whole is not the
   * same as HOLDING it whole: the buffer below writes it in slices, so the
   * overshoot costs a slice of memory rather than the row's weight.
   */
  private async runPass(kind: VectorDocKind, modelId: string): Promise<PassResult> {
    const plan = this.planFor(kind);
    const buffer = new SliceBuffer(this.index, kind);
    let processed = 0;
    let chars = 0;
    let lastId: number | null = null;

    try {
      for (const id of this.pendingIds(kind, modelId)) {
        if (processed >= MAX_DOCS_PER_BATCH || chars >= MAX_CHARS_PER_BATCH) break;
        buffer.openRow(id);
        for (const doc of this.rowDocs(kind, id, plan)) {
          processed++;
          chars += doc.text.length;
          await buffer.add(doc);
        }
        await buffer.closeRow();
        lastId = id;
      }
      await buffer.flush();
    } catch (error) {
      this.discardPartialRow(kind, buffer.partialRowId);
      throw error;
    }

    return { processed, embedded: buffer.embedded, lastId };
  }

  /**
   * Undo the committed slices of a row whose remaining slices never landed.
   *
   * A row must be all-or-nothing: it is the unit the resume skip asks about, so
   * a row left half-indexed would be skipped forever with the rest of its
   * documents missing and nothing to report it. Slices commit as they are
   * written, so the compensation is a delete rather than a rollback — the
   * index's own SAVEPOINT cannot span the awaits between slices, and holding a
   * transaction open across them would swallow the live capture writes that
   * share this connection.
   *
   * This answers a THROWN failure. A process killed mid-row is NOT covered: it
   * would leave the row's committed slices behind and the skip would pass over
   * them. That window is only open on rows above the caps — the rows whose
   * alternative was being held whole, which for a 100MB one measured 385-420MB
   * of resident memory in a process that had 22MB before it started.
   */
  private discardPartialRow(kind: VectorDocKind, sqliteId: number | null): void {
    if (sqliteId === null) return;
    try {
      this.index.deleteByParent(kind, sqliteId);
      logger.warn('VECTOR_INDEX', 'Discarded a partially indexed row', { kind, sqliteId });
    } catch (error) {
      logger.error('VECTOR_INDEX', 'Failed to discard a partially indexed row', {
        kind, sqliteId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * What one pass needs to know about this store's shape, worked out once.
   *
   * Columns are probed rather than assumed. observations.text is in the BASE
   * table while narrative/facts only arrive at schema v8, so BOTH halves can be
   * absent depending on how old the store is, and reading a missing column is a
   * hard SQL error that would abort the whole migration. Probed once per pass:
   * the answer cannot change under a running process, and asking again per row
   * — which is what the facts probe used to do — costs an uncached statement
   * compile and a table_info scan on every row of the corpus.
   */
  private planFor(kind: VectorDocKind): RowPlan {
    const { table, columns } = SCALAR_COLUMNS[kind];
    const present = columns.filter((column) => hasColumn(this.db, table, column));
    const facts = kind === 'observation' && hasColumn(this.db, 'observations', 'facts');
    // One character past the cut, so a value returned at full width is known to
    // be longer than the cut rather than merely equal to it.
    const width = EAGER_READ_CHARS + 1;
    const selected = present.map((column, at) => `substr(${column}, 1, ${width}) AS c${at}`);
    if (facts) selected.push(`substr(facts, 1, ${width}) AS facts`);
    return {
      table,
      columns: present,
      facts,
      sql: `SELECT ${selected.join(', ')} FROM ${table} WHERE id = ?`,
    };
  }

  /**
   * A row's documents, one at a time.
   *
   * A generator rather than an array: the caller embeds and releases each slice
   * before pulling the next document, which is the whole point — a row with
   * 100MB of facts is never a 100MB array of documents. The row's content
   * arrives in ONE statement, each column cut at EAGER_READ_CHARS, so the
   * ordinary row costs one lookup and still cannot hand back more than a slice
   * per column; only a column that came back cut is read again on its own.
   */
  private *rowDocs(kind: VectorDocKind, id: number, plan: RowPlan): Generator<VectorDoc> {
    if (plan.columns.length === 0 && !plan.facts) return;
    const row = this.db.query(plan.sql).get(id) as Record<string, unknown> | undefined;
    if (!row) return;

    for (let at = 0; at < plan.columns.length; at++) {
      const column = plan.columns[at];
      const value = this.whole(plan.table, column, id, row[`c${at}`]);
      if (!value) continue;
      yield {
        docId: scalarDocId(kind, id, column),
        sqliteId: id,
        fieldType: column,
        factIndex: null,
        text: value,
      };
    }
    if (plan.facts) yield* this.factDocs(id, row.facts);
  }

  /**
   * The eagerly read piece when it IS the whole value, else the value read on
   * its own.
   *
   * A cut piece is discarded rather than stitched onto: a scalar column becomes
   * exactly one document, so it has to be whole before it can be embedded at
   * all, and re-reading it costs what reading it always cost.
   */
  private whole(table: string, column: string, id: number, piece: unknown): string | null {
    if (piece === null || piece === undefined) return null;
    const text = String(piece);
    // UTF-16 length only ever OVERSTATES the characters SQLite counted, so this
    // can send a value that just fits down the re-read path — never keep a cut
    // one.
    if (text.length <= EAGER_READ_CHARS) return text;
    return this.readColumn(table, column, id);
  }

  /**
   * The fact documents of one observation.
   *
   * facts is a JSON array column, and it is the column that gets large: it is
   * split into elements a piece at a time, so what this process holds is one
   * piece and one document rather than the blob and every document it renders
   * to. `piece` is the eager read of the column: when it is the whole value —
   * which it is for every row whose facts fit in EAGER_READ_CHARS — the split
   * runs off it with no further query, and when it came back cut the pieces are read from
   * the column as before, first piece included. A malformed value degrades to
   * "this row has no fact documents" rather than stalling the whole backfill.
   */
  private *factDocs(id: number, piece: unknown): Generator<VectorDoc> {
    if (piece === null || piece === undefined) return;
    const eager = String(piece);
    const read = eager.length <= EAGER_READ_CHARS
      ? readerOver(eager)
      : (offset: number, width: number): string =>
          this.readColumnSlice('observations', 'facts', id, offset, width);
    for (const { index, text } of jsonArrayStrings(read)) {
      yield {
        docId: `obs_${id}_fact_${index}`,
        sqliteId: id,
        fieldType: 'fact',
        factIndex: index,
        text,
      };
    }
  }

  /**
   * `width` characters of a TEXT column from 1-based `offset`, or '' past its
   * end.
   *
   * SQLite has no cursor into the middle of a value, so a piece past the first
   * costs a walk of the value — which is why the caller reads whole values
   * whenever they fit and only pays per piece for the ones that do not.
   */
  private readColumnSlice(
    table: string, column: string, id: number, offset: number, width: number,
  ): string {
    const row = this.db.query(`SELECT substr(${column}, ?, ?) AS piece FROM ${table} WHERE id = ?`)
      .get(offset, width, id) as { piece: unknown } | undefined;
    return row && typeof row.piece === 'string' ? row.piece : '';
  }

  private readColumn(table: string, column: string, id: number): string | null {
    const row = this.db.query(`SELECT ${column} AS value FROM ${table} WHERE id = ?`)
      .get(id) as { value: unknown } | undefined;
    if (!row || row.value === null || row.value === undefined) return null;
    return String(row.value);
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

      const { processed, embedded, lastId } = await this.runPass(kind, modelId);

      if (lastId === null) {
        // The scan ran off the end of the table: this kind is done. Any row
        // still without a vector is one that renders to no document at all.
        this.finished.add(kind);
      } else {
        // Advanced only after a successful pass, so a throwing batch leaves the
        // cursor where it was and the caller can retry the same window.
        this.cursor.set(kind, lastId);
      }

      const remaining = this.pendingCount(kind, modelId);
      progress.push({ kind, processed, embedded, remaining });

      if (processed > 0) {
        logger.info('VECTOR_INDEX', 'Backfill batch', { kind, documents: processed, embedded, remaining });
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

/**
 * Accumulates documents up to the embed caps, then hands them to the index.
 *
 * This is what makes one pathological row affordable. The caps are the
 * embedder's, imported rather than restated, so a slice is both the largest
 * thing held in memory and exactly one embedder call.
 *
 * Slices do not straddle rows unless every row involved is whole in them: a row
 * that spans slices has its tail flushed at its own boundary, so at most ONE
 * row — the open one — can ever be half-written, and that is the row the pass
 * deletes if it throws. Rows small enough to share a slice still share one, so
 * an ordinary corpus is written in the same few large batches as before.
 */
class SliceBuffer {
  private docs: VectorDoc[] = [];
  private chars = 0;
  private openRowId: number | null = null;
  private openRowWritten = false;
  /** Vectors written, as the index reports them. */
  embedded = 0;

  constructor(
    private readonly index: VectorIndex,
    private readonly kind: VectorDocKind,
  ) {}

  openRow(sqliteId: number): void {
    this.openRowId = sqliteId;
    this.openRowWritten = false;
  }

  /** Adds one document, flushing first when it would push a cap. */
  async add(doc: VectorDoc): Promise<void> {
    const wouldExceed =
      this.docs.length >= MAX_EMBED_DOCS || this.chars + doc.text.length > MAX_EMBED_CHARS;
    // Never on an empty buffer: a single document larger than the character cap
    // still has to make progress.
    if (this.docs.length > 0 && wouldExceed) await this.flush();
    this.docs.push(doc);
    this.chars += doc.text.length;
  }

  /**
   * Ends the open row. Its tail is written now IF earlier slices of it already
   * were, so a row is never left spanning a flush boundary; a row that fits in
   * the buffer stays there and keeps batching with its neighbours.
   */
  async closeRow(): Promise<void> {
    if (this.openRowWritten) await this.flush();
    this.openRowId = null;
    this.openRowWritten = false;
  }

  async flush(): Promise<void> {
    if (this.docs.length === 0) return;
    const slice = this.docs;
    this.docs = [];
    this.chars = 0;
    // Set BEFORE the write, not after: a throw part-way through the write is
    // exactly the case the caller has to compensate for.
    if (this.openRowId !== null && slice.some((doc) => doc.sqliteId === this.openRowId)) {
      this.openRowWritten = true;
    }
    this.embedded += await this.index.upsert(this.kind, slice);
  }

  /** The row that a throw right now would leave half-written, if any. */
  get partialRowId(): number | null {
    return this.openRowWritten ? this.openRowId : null;
  }
}

function scalarDocId(kind: VectorDocKind, id: number, column: string): string {
  if (kind === 'observation') return `obs_${id}_${column}`;
  if (kind === 'summary') return `summary_${id}_${column}`;
  return `prompt_${id}`;
}

/**
 * The non-empty strings of a JSON array, with their positions, read one at a
 * time out of a column this never holds whole.
 *
 * JSON.parse would answer the same question — and did — but it answers it by
 * allocating every element at once, on top of the whole source text it was
 * handed. For the rows this exists to survive that is two copies of a blob
 * already too big to hold one of, and both stay live until the last document
 * of the row has been embedded.
 *
 * `read(offset, width)` hands back at most `width` characters from a 1-based
 * character offset — short means the value ended there. Pieces are re-read from
 * the last COMPLETE element rather than stitched together: a piece that ends
 * mid-element is simply cut there, so nothing is ever concatenated and the only
 * strings alive are one piece and one element. An element too wide for a piece
 * widens the read instead, so a single enormous fact still makes progress.
 *
 * Decoding stays JSON.parse's job, per element. What is hand-written here is
 * only where an element ends, which is a matter of quoting and nesting.
 *
 * Positions are the element's index in the array, non-strings included, because
 * that index is half of a document's identity (obs_<id>_fact_<i>) and it has to
 * mean the same thing it meant when ChromaSync minted it.
 *
 * Anything that is not a JSON array, and anything malformed from the point of
 * malformation on, yields nothing further — a bad blob costs its own row's
 * facts, never the pass.
 */
export function* jsonArrayStrings(
  read: (offset: number, width: number) => string,
  chunkChars: number = FACTS_CHUNK_CHARS,
): Generator<{ index: number; text: string }> {
  let offset = 1; // substr() counts from 1
  let width = chunkChars;
  let piece = read(offset, width);
  // A piece shorter than it asked for is the end of the value. UTF-16 length
  // only ever OVERSTATES the characters SQLite counted, so this never claims an
  // end that has not come.
  let ended = piece.length < width;

  // Whitespace can be all a piece holds, before the array even opens.
  let at = skipSpace(piece, 0);
  while (at >= piece.length) {
    if (ended) return;
    offset += codePointLength(piece);
    piece = read(offset, width);
    ended = piece.length < width;
    at = skipSpace(piece, 0);
  }
  if (piece[at] !== '[') return;
  at++;
  let index = 0;

  while (true) {
    at = skipSpace(piece, at);
    let end = at < piece.length ? elementEnd(piece, at) : -1;

    // The piece stops mid-element. Re-read from the start of this element, or,
    // when the element alone is wider than a piece, with room for more of it.
    // Either the offset moves or the width grows, so this always progresses.
    while (end < 0) {
      if (ended) return;
      if (at === 0) width *= 2;
      else offset += codePointLength(piece.slice(0, at));
      piece = read(offset, width);
      ended = piece.length < width;
      at = skipSpace(piece, 0);
      end = at < piece.length ? elementEnd(piece, at) : -1;
    }

    if (piece[at] === ']') return;

    let value: unknown;
    try {
      value = JSON.parse(piece.slice(at, end));
    } catch {
      return;
    }
    if (typeof value === 'string' && value.length > 0) yield { index, text: value };
    index++;

    // elementEnd only returns on a delimiter it actually saw, so the character
    // that closed the element is in hand and never straddles a piece.
    at = skipSpace(piece, end);
    if (piece[at] !== ',') return;
    at++;
  }
}

function skipSpace(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const code = source.charCodeAt(at);
    // space, tab, LF, CR — the only whitespace JSON allows between tokens.
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    at++;
  }
  return at;
}

/**
 * Index one past the element starting at `from`: the following comma, or the
 * array's closing bracket. -1 when the piece runs out first, which is the
 * signal to read more of the value rather than to give up on it.
 */
function elementEnd(source: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let at = from; at < source.length; at++) {
    const code = source.charCodeAt(at);
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (code === 0x5c) escaped = true;        // backslash
      else if (code === 0x22) inString = false; // quote
      continue;
    }
    if (code === 0x22) { inString = true; continue; }
    if (code === 0x5b || code === 0x7b) { depth++; continue; }  // [ {
    if (code === 0x5d || code === 0x7d) {                       // ] }
      if (depth === 0) return at;
      depth--;
      continue;
    }
    if (code === 0x2c && depth === 0) return at;                // ,
  }
  return -1;
}

/**
 * Serves a value already in hand the way readColumnSlice serves one still in
 * the column: 1-based, counted in code points, short at the end.
 *
 * The splitter is the same either way. What changes is only where the pieces
 * come from, so a column narrow enough to have been read whole costs no
 * further query while a wide one keeps paying per piece.
 */
function readerOver(value: string): (offset: number, width: number) => string {
  return (offset, width) => {
    const from = utf16IndexOf(value, offset - 1);
    return value.slice(from, utf16IndexOf(value, offset - 1 + width));
  };
}

/** UTF-16 index of code point number `count`, or the end of `value`. */
function utf16IndexOf(value: string, count: number): number {
  let at = 0;
  for (let seen = 0; seen < count && at < value.length; seen++) {
    const code = value.charCodeAt(at);
    at += code >= 0xd800 && code <= 0xdbff && at + 1 < value.length ? 2 : 1;
  }
  return at;
}

/**
 * Characters as SQLite counts them: one per code point, not per UTF-16 unit.
 * substr() offsets are in these, and a piece never splits a surrogate pair.
 */
function codePointLength(text: string): number {
  let count = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) at++;
    count++;
  }
  return count;
}
