import { Database, type Statement } from 'bun:sqlite';
import { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isDirectChild, normalizePath } from '../../shared/path-utils.js';
import {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
  DateRange,
  ObservationRow
} from './types.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveDateBound } from '../../shared/date-bounds.js';
import {
  applySqliteConnectionPragmas,
  assertSchemaWriterCompatible,
  checkAndRaiseSchemaWriterStampInTransaction,
  LATEST_SCHEMA_VERSION,
  SchemaNewerThanBinaryError,
} from './connection.js';
import { projectScopeSql, scopedProjects } from './project-read-keys.js';
import { pageMatchingRows } from './stream-rows.js';

/**
 * Code-point ranges of the scripts FTS5's unicode61 tokenizer cannot segment: Thai and Lao,
 * Myanmar, Khmer, Hiragana/Katakana, Bopomofo and Hangul compatibility jamo, the CJK
 * ideograph blocks, and Hangul syllables. See {@link SessionSearch.UNSEGMENTED_SCRIPT}.
 */
const UNSEGMENTED_SCRIPT_RANGES =
  '\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';

/**
 * The sync triggers each external-content index depends on. SQLite drops a
 * table's triggers along with the table, so any DROP TABLE rebuild (the v7/v9
 * migrations) removes them while the index itself survives — their presence is
 * introspected separately from the index tables' (#3609).
 */
export const OBSERVATIONS_FTS_TRIGGER_NAMES = ['observations_ai', 'observations_ad', 'observations_au'];
export const SESSION_SUMMARIES_FTS_TRIGGER_NAMES = [
  'session_summaries_ai',
  'session_summaries_ad',
  'session_summaries_au',
];

/**
 * Sync triggers for the external-content FTS5 indexes, shared by FTS setup here and by the
 * SessionStore migrations that rebuild these tables. The update triggers fire only when an
 * indexed column is written: an unscoped AFTER UPDATE also fired for bookkeeping writes
 * (sync_rev, merged_into_project, content_hash, ...), and every firing appended a delete
 * marker plus a full re-insert of the row's text to the index (#2793).
 */
export const OBSERVATIONS_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_au
  AFTER UPDATE OF title, subtitle, narrative, text, facts, concepts ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;
`;

export const SESSION_SUMMARIES_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_au
  AFTER UPDATE OF request, investigated, learned, completed, next_steps, notes ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;
`;

type AnyTermFtsTable = 'observations_fts' | 'session_summaries_fts';

/** Rows of an FTS table holding a word, and the table's row count, for one any-term query. */
interface DocFrequency {
  rows: (word: string) => number;
  total: number;
}

export class SessionSearch {
  private db: Database;

  constructor(dbPathOrDb: string | Database = DB_PATH) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      ensureDir(DATA_DIR);
      this.db = new Database(dbPathOrDb);
    }

    // Refuse before any DDL when the database's schema is newer than this
    // binary's chain (#3609 step 2); a refused open touches nothing.
    assertSchemaWriterCompatible(this.db, LATEST_SCHEMA_VERSION);

    applySqliteConnectionPragmas(this.db);

    this._fts5Available = this.isFts5Available();

    this.ensureFTSTables();
  }

  private _fts5Available: boolean;

  private ensureFTSTables(): void {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasObservationsFTS = tables.some(t => t.name === 'observations_fts');
    const hasSummariesFTS = tables.some(t => t.name === 'session_summaries_fts');

    // #3609 — the tables alone are not proof of a working index: a DROP TABLE
    // rebuild (v7/v9) drops the sync triggers with the table while the index
    // survives, and writes then silently stopped reaching it. Introspect the
    // triggers too; missing ones are recreated in the transaction below.
    if (
      hasObservationsFTS &&
      hasSummariesFTS &&
      this.hasAllFtsTriggers(OBSERVATIONS_FTS_TRIGGER_NAMES) &&
      this.hasAllFtsTriggers(SESSION_SUMMARIES_FTS_TRIGGER_NAMES)
    ) {
      return;
    }

    if (!this.isFts5Available()) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    const repairingTriggersOnly = hasObservationsFTS && hasSummariesFTS;
    logger.info('DB', repairingTriggersOnly ? 'Converging FTS5 indexes and recreating missing sync triggers' : 'Creating FTS5 tables');

    try {
      this.db.transaction(() => {
        // The FTS DDL below is this constructor's only schema write, so the
        // writer stamp is re-checked and raised under the same write lock
        // first (#3609 step 2, #4602 review): a newer worker that stamped
        // after the constructor's initial check still refuses this one, and
        // the stamp commits only together with the DDL. A connection that
        // writes nothing — FTS tables already present, no FTS5 — records no
        // writer.
        checkAndRaiseSchemaWriterStampInTransaction(this.db, LATEST_SCHEMA_VERSION);
        // Another connection may have completed setup after the initial read.
        // Hold the writer reservation while deciding which indexes we own.
        const currentTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
        const createObservations = !currentTables.some(t => t.name === 'observations_fts');
        const createSummaries = !currentTables.some(t => t.name === 'session_summaries_fts');
        // Recreate triggers only for indexes that already exist, converging
        // each one first: rows written while the triggers were gone are absent
        // from the index, and the _ad/_au triggers would fail every
        // UPDATE/DELETE of those rows with "database disk image is malformed"
        // once they re-attach and serve their FTS 'delete' commands (#3609).
        const repairObservations = !createObservations && !this.hasAllFtsTriggers(OBSERVATIONS_FTS_TRIGGER_NAMES);
        const repairSummaries = !createSummaries && !this.hasAllFtsTriggers(SESSION_SUMMARIES_FTS_TRIGGER_NAMES);
        this.createFTSTablesAndTriggers(createObservations, createSummaries);
        if (repairObservations) {
          this.rebuildFtsIndex('observations_fts');
          this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
        }
        if (repairSummaries) {
          this.rebuildFtsIndex('session_summaries_fts');
          this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
        }
      }).immediate();
      logger.info('DB', repairingTriggersOnly ? 'FTS5 indexes converged and sync triggers recreated' : 'FTS5 tables created successfully');
    } catch (error) {
      if (error instanceof SchemaNewerThanBinaryError) {
        throw error;
      }
      this._fts5Available = false;
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error instanceof Error ? error : undefined);
    }
  }

  /** True when every trigger in `names` exists — presence, not its DDL (v54 owns the shape). */
  private hasAllFtsTriggers(names: string[]): boolean {
    const placeholders = names.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`)
      .all(...names) as { name: string }[];
    return rows.length === names.length;
  }

  /**
   * Converge a surviving external-content index with its content table by
   * re-deriving the whole index from the content table. Rows written while the
   * sync triggers were gone (the v7/v9 window, #3609) never reached the index,
   * and the _ad/_au triggers answer every UPDATE/DELETE of such a row with an
   * FTS 'delete' command — for a rowid the index does not hold, FTS5 fails the
   * write with SQLITE_CORRUPT, surfaced by Bun SQLite as "database disk image
   * is malformed". 'rebuild' is the documented, idempotent resync: no drift
   * detection, no per-row backfill bookkeeping, and a fully consistent index
   * converges to itself. One-time cost — the repair only runs while triggers
   * are missing.
   */
  private rebuildFtsIndex(ftsTable: 'observations_fts' | 'session_summaries_fts'): void {
    this.db.run(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
  }

  private isFts5Available(): boolean {
    try {
      this.db.run('CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(test_column)');
      this.db.run('DROP TABLE temp._fts5_probe');
      return true;
    } catch (error) {
      logger.debug('DB', 'FTS5 probe failed — FTS5 unavailable on this platform', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** An existing index can still be read when the writable probe is denied. */
  private canReadFtsIndex(table: 'observations_fts' | 'session_summaries_fts'): boolean {
    try {
      // Preparing this read loads the virtual table and checks MATCH support
      // without creating tables, changing the connection or scanning rows.
      this.db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 0`).all('"fts_read_probe"');
      return true;
    } catch {
      return false;
    }
  }

  private createFTSTablesAndTriggers(createObservations: boolean, createSummaries: boolean): void {
    // Backfill only newly created indexes: reinserting into an existing FTS5
    // external-content index can corrupt its delete/update bookkeeping.
    if (createObservations) {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          text,
          facts,
          concepts,
          content='observations',
          content_rowid='id'
        );
      `);

      this.db.run(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `);

      this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
    }

    if (createSummaries) {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id'
        );
      `);

      this.db.run(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `);

      this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
    }
  }

  private buildFilterClause(
    filters: SearchFilters,
    params: any[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    const projects = scopedProjects(filters);
    if (projects.length > 0) {
      // #3641 — match the OR disjunction used by every other read path
      // (SessionStore, PaginationHelper, ObservationCompiler). Without it the
      // FTS/filter path ignores merged_into_project, so adopted worktree
      // observations stay invisible to search even after adoption.
      // #3531 — compared case-insensitively, like every other read path.
      // Gate P2-5 — every key the checkout reads, not just its current one.
      const scope = projectScopeSql(tableAlias, projects, { includeMerged: true });
      conditions.push(scope.sql);
      params.push(...scope.params);
    }

    // Source-scoping (#2389): when a platformSource is supplied, restrict to
    // rows whose owning sdk_session has that platform_source. observations and
    // session_summaries both carry memory_session_id, which is the FK into
    // sdk_sessions. COALESCE mirrors PaginationHelper: legacy rows with a NULL
    // platform_source are treated as 'claude' so they never bleed into a
    // codex/other-agent search.
    if (filters.platformSource) {
      conditions.push(
        `COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${tableAlias}.memory_session_id), ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`
      );
      params.push(normalizePlatformSource(filters.platformSource));
    }

    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => '?').join(',');
        conditions.push(`${tableAlias}.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        conditions.push(`${tableAlias}.type = ?`);
        params.push(filters.type);
      }
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(resolveDateBound(start, 'start'));
      }
      if (end) {
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(resolveDateBound(end, 'end'));
      }
    }

    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptColumn = `${tableAlias}.concepts`;
      // Legacy concepts can be a plain string or JSON string, matching sync's list reader.
      const conceptArray = `CASE WHEN json_valid(${conceptColumn}) THEN CASE
        WHEN json_type(${conceptColumn}) = 'array' THEN ${conceptColumn}
        WHEN json_type(${conceptColumn}) = 'text' THEN json_array(json_extract(${conceptColumn}, '$'))
        ELSE json_array(${conceptColumn}) END ELSE json_array(${conceptColumn}) END`;
      const conceptConditions = concepts.map(() => {
        return `EXISTS (SELECT 1 FROM json_each(${conceptArray}) WHERE type = 'text' AND value = ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const changedFilesColumn = tableAlias === 's' ? 'files_edited' : 'files_modified';
      const fileConditions = files.map(() => {
        return `(
          EXISTS (SELECT 1 FROM json_each(${SessionSearch.fileArrayJson(`${tableAlias}.files_read`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(${SessionSearch.fileArrayJson(`${tableAlias}.${changedFilesColumn}`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          const literal = file.replace(/[\\%_]/g, '\\$&');
          params.push(`%${literal}%`, `%${literal}%`);
        });
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /**
   * Scripts whose runs FTS5's unicode61 tokenizer cannot split: Hiragana, Katakana, the CJK
   * ideograph blocks, Bopomofo, and Hangul. unicode61 breaks on Unicode whitespace and
   * punctuation, and these scripts put neither between the characters of a run — so a run
   * folds into a single token and no substring of it can ever match (#3801), which is every
   * query a user types in them.
   *
   * Korean does space its words, so only the sub-word case is affected there — but that is
   * still every partial-word query. Measured directly against `tokenize='unicode61'`:
   *
   *   설정   inside 설정을            -> 0 rows
   *   설정을 as a whole token         -> 1 row
   *   ㄓㄨ   inside ㄓㄨㄛ            -> 0 rows
   *   项目   inside 修改了项目配置    -> 0 rows
   *
   * Bopomofo and Hangul were raised in review on #3810. The blocks are adjacent, so
   * \u3100-\u318F covers Bopomofo together with the Hangul compatibility jamo beside it.
   *
   * Thai, Lao, Myanmar and Khmer write words without spaces too, so a run of them folds
   * into one token the same way (`ภาษาไทย` inside a longer Thai run -> 0 rows).
   */
  private static readonly UNSEGMENTED_SCRIPT = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]`);

  /**
   * Split the query into the runs the index cannot segment and the runs it can, so a
   * mixed-script query is matched term by term instead of as one literal string. A
   * substring search for the whole of `claude 队列` requires those characters to be
   * adjacent, which is why mixed queries returned almost nothing (#3801 / #3982).
   */
  private static readonly UNSEGMENTED_RUN =
    new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]+|[^\\s${UNSEGMENTED_SCRIPT_RANGES}]+`, 'g');

  /**
   * The most distinct terms the substring predicate requires. It adds one LIKE group per
   * term, and when SQLite plans the project filter's OR across its two indexes it chains
   * every WHERE term into one AND expression, one level deeper per term. Past ~980 terms
   * that fails with "Expression tree is too large (maximum depth 1000)", which a pasted
   * wall of text (FTS never matches one, so it always lands here) used to hit. 500 leaves
   * room for every other filter. A query with more distinct terms than this matches no
   * record by its full AND anyway; its leading terms are kept.
   */
  static readonly MAX_SUBSTRING_TERMS = 500;

  /**
   * Build the substring predicate used when the index cannot represent the query. Each
   * term must appear in at least one column, and every term must appear somewhere. The
   * escaping matches {@link searchUserPrompts}, which has always searched by substring.
   * A repeated term adds nothing to the AND, so terms are deduplicated before the cap.
   */
  private static buildSubstringClause(query: string, columns: string[]): { clause: string; params: string[] } {
    const terms = [...new Set(query.match(SessionSearch.UNSEGMENTED_RUN) ?? [])]
      .slice(0, SessionSearch.MAX_SUBSTRING_TERMS);
    if (terms.length === 0) {
      terms.push(query);
    }
    const params: string[] = [];
    const groups = terms.map(term => {
      const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      for (let i = 0; i < columns.length; i += 1) {
        params.push(pattern);
      }
      return `(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    });
    return { clause: `(${groups.join(' AND ')})`, params };
  }

  /** Fewest query terms before an AND query with no match is widened to any term (see buildFTSAnyTermQuery). */
  private static readonly MIN_ANY_TERM_TOKENS = 3;

  /**
   * Build an FTS5 query that preserves literal-token safety while allowing multi-word
   * input to behave as an AND of terms instead of an exact phrase.
   *
   * Tokens with no letter or digit (a lone `-`, `&`, `—`) are dropped: unicode61 indexes
   * nothing for them, so each would become an empty phrase that matches no row and, ANDed
   * in, would zero out the whole query.
   */
  private static buildFTSMatchQuery(query: string): string {
    const tokens = (query.match(/\S+/g) ?? []).filter(token => /[\p{L}\p{N}]/u.test(token));
    if (tokens.length === 0) {
      return `"${query.replace(/"/g, '""')}"`;
    }

    return tokens
      .map(token => `"${token.replace(/"/g, '""')}"`)
      .join(' AND ');
  }

  /**
   * The same quoted tokens as buildFTSMatchQuery, joined with OR, for a query whose terms never all appear in one
   * row. A natural-language question ("when did we change the retry limit") almost never has every word in one
   * observation, so the AND query matches nothing; OR lets FTS5's bm25 rank the rows that share the most, and the
   * rarest, terms first. Queries of one or two terms stay keyword queries, matched with AND as #4130 intends
   * ("authentication bug" must not widen to every row that mentions "bug"); widening starts at three terms, where
   * a query reads as a question. Null when the query is not widened.
   *
   * The OR is bounded by prompt size (#4804): FTS5 scores every row holding any term before the filters apply, so
   * an OR of every word of a long prompt ran for minutes on a large store. Document frequencies come from an
   * fts5vocab table in this connection's temp schema, looked up one term at a time.
   *
   *   prompt chars | terms kept
   *   < 200        | its tokens, deduplicated, minus those whose rarest word is in >= 30% of rows; at most 40, rarest first
   *   200..600     | the same, at most 60
   *   >= 600       | the first 40 distinct words of >= 3 characters that are in at least one row and in < 2% of rows
   *
   * Without the vocabulary (no FTS5 vocab module, or a connection that cannot create temp tables) the tokens are
   * deduplicated and capped at 40.
   */
  private buildFTSAnyTermQuery(query: string, ftsTable: AnyTermFtsTable): string | null {
    const tokens = (query.match(/\S+/g) ?? []).filter(token => /[\p{L}\p{N}]/u.test(token));
    if (tokens.length < SessionSearch.MIN_ANY_TERM_TOKENS) {
      return null;
    }

    const docFrequency = this.termDocFrequency(ftsTable);
    const length = [...query].length;
    let picked: string[];
    if (!docFrequency) {
      picked = SessionSearch.dedupeTokens(tokens).slice(0, SessionSearch.ANY_TERM_LONG_PROMPT_CAP);
    } else if (length < SessionSearch.ANY_TERM_SHORT_PROMPT_CHARS) {
      picked = SessionSearch.pickRareTokens(tokens, docFrequency, SessionSearch.ANY_TERM_SHORT_PROMPT_CAP);
    } else if (length < SessionSearch.ANY_TERM_MEDIUM_PROMPT_CHARS) {
      picked = SessionSearch.pickRareTokens(tokens, docFrequency, SessionSearch.ANY_TERM_MEDIUM_PROMPT_CAP);
    } else {
      picked = SessionSearch.pickRareWords(query, docFrequency);
    }

    if (picked.length === 0) {
      return null;
    }
    return picked
      .map(token => `"${token.replace(/"/g, '""')}"`)
      .join(' OR ');
  }

  private static readonly ANY_TERM_SHORT_PROMPT_CHARS = 200;
  private static readonly ANY_TERM_MEDIUM_PROMPT_CHARS = 600;
  private static readonly ANY_TERM_SHORT_PROMPT_CAP = 40;
  private static readonly ANY_TERM_MEDIUM_PROMPT_CAP = 60;
  private static readonly ANY_TERM_LONG_PROMPT_CAP = 40;
  /** Short and medium prompts drop a token whose rarest word is in this share of rows or more. */
  private static readonly ANY_TERM_COMMON_SHARE = 0.30;
  /** Long prompts keep only words in less than this share of rows. */
  private static readonly ANY_TERM_LONG_PROMPT_MAX_SHARE = 0.02;
  private static readonly ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS = 3;
  private static readonly ANY_TERM_CONTENT_TABLES: Record<AnyTermFtsTable, string> = {
    observations_fts: 'observations',
    session_summaries_fts: 'session_summaries',
  };

  /** Per FTS table: the temp-schema vocabulary lookup, or null once it could not be created on this connection. */
  private readonly vocabLookups = new Map<AnyTermFtsTable, Statement | null>();

  /**
   * A document-frequency reader for one query: `(word) => rows holding it`, plus the row count. Null when the
   * vocabulary is unavailable. Words are folded the way unicode61 indexes them (lowercase, no diacritics).
   */
  private termDocFrequency(ftsTable: AnyTermFtsTable): DocFrequency | null {
    if (!this.vocabLookups.has(ftsTable)) {
      let lookup: Statement | null = null;
      try {
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${ftsTable}_vocab USING fts5vocab(main, '${ftsTable}', 'row')`);
        lookup = this.db.prepare(`SELECT doc FROM temp.${ftsTable}_vocab WHERE term = ?`);
      } catch (error) {
        logger.debug('DB', 'FTS5 vocabulary unavailable; any-term queries are capped without frequencies', { ftsTable }, error instanceof Error ? error : undefined);
      }
      this.vocabLookups.set(ftsTable, lookup);
    }
    const lookup = this.vocabLookups.get(ftsTable);
    if (!lookup) {
      return null;
    }
    try {
      const contentTable = SessionSearch.ANY_TERM_CONTENT_TABLES[ftsTable];
      const total = (this.db.prepare(`SELECT count(*) AS n FROM ${contentTable}`).get() as { n: number }).n;
      const cache = new Map<string, number>();
      const rows = (word: string): number => {
        const term = word.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        let doc = cache.get(term);
        if (doc === undefined) {
          doc = (lookup.get(term) as { doc: number } | null)?.doc ?? 0;
          cache.set(term, doc);
        }
        return doc;
      };
      return { rows, total };
    } catch (error) {
      logger.debug('DB', 'FTS5 vocabulary lookup failed; any-term queries are capped without frequencies', { ftsTable }, error instanceof Error ? error : undefined);
      this.vocabLookups.set(ftsTable, null);
      return null;
    }
  }

  /** A token is as common as its rarest word: FTS splits `qa-hub,` into `qa` and `hub`, and a phrase needs both. */
  private static tokenRows(token: string, docFrequency: DocFrequency): number {
    const words = token.match(/[\p{L}\p{N}]+/gu) ?? [];
    return words.length === 0 ? 0 : Math.min(...words.map(word => docFrequency.rows(word)));
  }

  /**
   * Rows at or above which a word counts as common. A word in a single row is never common, so a small store
   * still widens: 2% of 30 rows is less than one row.
   */
  private static commonRowLimit(total: number, share: number): number {
    return Math.max(total * share, 2);
  }

  /** Tokens deduplicated case-insensitively, keeping each one's first spelling: `Retry retry RETRY` is one term. */
  private static dedupeTokens(tokens: string[]): string[] {
    const seen = new Set<string>();
    return tokens.filter(token => {
      const key = token.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private static pickRareTokens(tokens: string[], docFrequency: DocFrequency, cap: number): string[] {
    const limit = SessionSearch.commonRowLimit(docFrequency.total, SessionSearch.ANY_TERM_COMMON_SHARE);
    const kept = SessionSearch.dedupeTokens(tokens).filter(token => SessionSearch.tokenRows(token, docFrequency) < limit);
    if (kept.length <= cap) {
      return kept;
    }
    return kept
      .map(token => ({ token, rows: SessionSearch.tokenRows(token, docFrequency) }))
      .sort((a, b) => a.rows - b.rows)
      .slice(0, cap)
      .map(entry => entry.token);
  }

  private static pickRareWords(query: string, docFrequency: DocFrequency): string[] {
    const limit = SessionSearch.commonRowLimit(docFrequency.total, SessionSearch.ANY_TERM_LONG_PROMPT_MAX_SHARE);
    const words = new Set(
      (query.match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(word => [...word].length >= SessionSearch.ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS)
        .map(word => word.toLowerCase()),
    );
    const kept: string[] = [];
    for (const word of words) {
      const rows = docFrequency.rows(word);
      if (rows > 0 && rows < limit) {
        kept.push(word);
        if (kept.length === SessionSearch.ANY_TERM_LONG_PROMPT_CAP) {
          break;
        }
      }
    }
    return kept;
  }

  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance', hasFTS: boolean = true, ftsTable: string = 'observations_fts'): string {
    switch (orderBy) {
      case 'relevance':
        return hasFTS ? `ORDER BY ${ftsTable}.rank ASC` : 'ORDER BY o.created_at_epoch DESC';
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC, o.id DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC, o.id ASC';
      default:
        return 'ORDER BY o.created_at_epoch DESC';
    }
  }

  private searchObservationsBySubstring(
    query: string,
    filters: SearchFilters,
    orderBy: SearchOptions['orderBy'],
    limit: number,
    offset: number
  ): ObservationSearchResult[] {
    const match = SessionSearch.buildSubstringClause(query, [
      'o.title', 'o.subtitle', 'o.narrative', 'o.text', 'o.facts', 'o.concepts',
    ]);
    const filterParams: any[] = [];
    const filterClause = this.buildFilterClause(filters, filterParams, 'o');

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${match.clause}
      ${filterClause ? 'AND ' + filterClause : ''}
      ${this.buildOrderClause(orderBy, false)}
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...match.params, ...filterParams, limit, offset) as ObservationSearchResult[];
  }

  private searchSessionsBySubstring(
    query: string,
    filters: SearchFilters,
    orderBy: SearchOptions['orderBy'],
    limit: number,
    offset: number
  ): SessionSummarySearchResult[] {
    const match = SessionSearch.buildSubstringClause(query, [
      's.request', 's.investigated', 's.learned', 's.completed', 's.next_steps', 's.notes',
    ]);
    const filterOptions = { ...filters };
    delete filterOptions.type;
    const filterParams: any[] = [];
    const filterClause = this.buildFilterClause(filterOptions, filterParams, 's');
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY s.created_at_epoch ASC, s.id ASC'
      : 'ORDER BY s.created_at_epoch DESC, s.id DESC';

    const sql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${match.clause}
      ${filterClause ? 'AND ' + filterClause : ''}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    return this.db.prepare(sql).all(...match.params, ...filterParams, limit, offset) as SessionSummarySearchResult[];
  }

  searchObservations(query: string | undefined, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        // No query text and no filters: nothing to match, so return an empty
        // result set rather than treating a benign empty search as an error.
        return [];
      }

      const orderClause = this.buildOrderClause(orderBy, false);

      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    }

    if (SessionSearch.UNSEGMENTED_SCRIPT.test(query)) {
      return this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
    }

    if (this._fts5Available || this.canReadFtsIndex('observations_fts')) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      const orderClause = this.buildOrderClause(orderBy, true, 'observations_fts');

      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${filterClause ? 'AND ' + filterClause : ''}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.unshift(SessionSearch.buildFTSMatchQuery(query));

      let rows: ObservationSearchResult[];
      try {
        rows = this.db.prepare(sql).all(...params, limit, offset) as ObservationSearchResult[];
      } catch (error) {
        logger.warn('DB', 'FTS5 observation search failed', {}, error instanceof Error ? error : undefined);
        throw error;
      }
      // An empty page past the end of real FTS matches stays empty.
      if (rows.length > 0 || (offset > 0 && this.db.prepare(sql).all(...params, 1, 0).length > 0)) {
        return rows;
      }
      // No FTS match at all. unicode61 folds a Latin run glued to ideographs (`payload优先使用LLM`)
      // into one token that no FTS term can reach, so answer by substring, the same way queries in
      // unsegmented scripts are answered. A query FTS already answers is never widened.
      const substringRows = this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
      if (substringRows.length > 0 || (offset > 0 && this.searchObservationsBySubstring(query, filters, orderBy, 1, 0).length > 0)) {
        return substringRows;
      }
      // No row holds every term, as a token or as a substring: widen to any term, ranked by bm25.
      return this.searchFtsAnyTerm<ObservationSearchResult>(sql, query, params, limit, offset, 'observations_fts') ?? substringRows;
    }

    return this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
  }

  searchSessions(query: string | undefined, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        // No query text and no filters: nothing to match, so return an empty
        // result set rather than treating a benign empty search as an error.
        return [];
      }

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC, s.id ASC'
        : 'ORDER BY s.created_at_epoch DESC, s.id DESC';

      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
    }

    if (SessionSearch.UNSEGMENTED_SCRIPT.test(query)) {
      return this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
    }

    if (this._fts5Available || this.canReadFtsIndex('session_summaries_fts')) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC, s.id ASC'
        : orderBy === 'date_desc'
          ? 'ORDER BY s.created_at_epoch DESC, s.id DESC'
          : 'ORDER BY session_summaries_fts.rank ASC';

      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${filterClause ? 'AND ' + filterClause : ''}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.unshift(SessionSearch.buildFTSMatchQuery(query));

      let rows: SessionSummarySearchResult[];
      try {
        rows = this.db.prepare(sql).all(...params, limit, offset) as SessionSummarySearchResult[];
      } catch (error) {
        logger.warn('DB', 'FTS5 session search failed', {}, error instanceof Error ? error : undefined);
        throw error;
      }
      if (rows.length > 0 || (offset > 0 && this.db.prepare(sql).all(...params, 1, 0).length > 0)) {
        return rows;
      }
      // No FTS match at all: answer by substring, then widen to any term (see searchObservations).
      const substringRows = this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
      if (substringRows.length > 0 || (offset > 0 && this.searchSessionsBySubstring(query, filters, orderBy, 1, 0).length > 0)) {
        return substringRows;
      }
      return this.searchFtsAnyTerm<SessionSummarySearchResult>(sql, query, params, limit, offset, 'session_summaries_fts') ?? substringRows;
    }

    return this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
  }

  /**
   * Re-run an FTS search whose AND form, and the substring fallback, matched nothing with the any-term form. `params[0]` is the MATCH
   * argument and the rest are the filter parameters, as built by the callers. Returns null when the query has
   * nothing to widen or the any-term form matches nothing either.
   */
  private searchFtsAnyTerm<T>(
    sql: string,
    query: string,
    params: any[],
    limit: number,
    offset: number,
    ftsTable: AnyTermFtsTable,
  ): T[] | null {
    const anyTermQuery = this.buildFTSAnyTermQuery(query, ftsTable);
    if (!anyTermQuery) {
      return null;
    }
    const anyTermParams = [anyTermQuery, ...params.slice(1)];
    const rows = this.db.prepare(sql).all(...anyTermParams, limit, offset) as T[];
    if (rows.length > 0 || (offset > 0 && this.db.prepare(sql).all(...anyTermParams, 1, 0).length > 0)) {
      return rows;
    }
    return null;
  }

  findByConcept(concept: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    const conceptFilters = { ...filters, concepts: concept };
    const filterClause = this.buildFilterClause(conceptFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  private hasDirectChildFile(obs: ObservationSearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => typeof f === 'string' && isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug('DB', `Failed to parse files JSON for observation ${obs.id}`, undefined, error instanceof Error ? error : undefined);
      }
      return false;
    };

    return checkFiles(obs.files_modified) || checkFiles(obs.files_read);
  }

  private hasDirectChildFileSession(session: SessionSummarySearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => typeof f === 'string' && isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug('DB', `Failed to parse files JSON for session summary ${session.id}`, undefined, error instanceof Error ? error : undefined);
      }
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  /**
   * LIKE patterns that find a path in a files JSON column.
   *
   * Stored paths come in two forms: absolute when they come from a tool's
   * input (Claude Code's Read/Edit/Write), project-relative when they come
   * from the observer's output or a Codex patch, and neither records the
   * project root. So a folder given as an absolute path also matches paths
   * stored under any trailing part of it, which is the rule isDirectChild
   * applies to the fetched rows. Without these anchored prefixes the
   * project-relative rows never reached that check and folder lookups missed
   * them.
   */
  private static filePathPatterns(filePath: string, isFolder: boolean): string[] {
    const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
    const variants = isFolder
      ? [filePath, normalizePath(filePath), normalizePath(filePath).replaceAll('/', '\\')]
      : [filePath];
    const patterns = [...new Set(variants)].map(value => `%${escape(value)}%`);
    if (!isFolder || !/^([A-Za-z]:)?[\\/]/.test(filePath)) {
      return patterns;
    }
    const segments = normalizePath(filePath).split('/').filter(segment => segment.length > 0);
    const firstRelativeSegment = /^[A-Za-z]:$/.test(segments[0] ?? '') ? 1 : 0;
    for (let start = firstRelativeSegment; start < segments.length; start += 1) {
      const trailing = segments.slice(start);
      patterns.push(`${escape(trailing.join('/') + '/')}%`);
      if (filePath.includes('\\')) {
        patterns.push(`${escape(trailing.join('\\') + '\\')}%`);
      }
    }
    return patterns;
  }

  /** Invalid persisted file lists are absent evidence, rather than a query-wide JSON error. */
  private static fileArrayJson(column: string): string {
    return `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END ELSE '[]' END`;
  }

  /** Any of `columns` (JSON arrays) holds a value matching any pattern; bind every pattern once per column. */
  private static jsonArrayLikeClause(columns: string[], patternCount: number): string {
    const anyPattern = Array.from({ length: patternCount }, () => "type = 'text' AND value LIKE ? ESCAPE '\\'").join(' OR ');
    return `(${columns.map(column => `EXISTS (SELECT 1 FROM json_each(${SessionSearch.fileArrayJson(column)}) WHERE ${anyPattern})`).join(' OR ')})`;
  }

  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;
    // filePath is the file filter; a caller's own `files` filter is not added on top.
    delete filters.files;

    // Folder matching removes nested descendants, so a folder query pages the
    // matching rows (pageMatchingRows), not a guessed multiple of the broader
    // SQL candidates.
    const paginationSql = isFolder ? '' : 'LIMIT ? OFFSET ?';
    const pathPatterns = SessionSearch.filePathPatterns(filePath, isFolder);

    const filterClause = this.buildFilterClause(filters, params, 'o');
    params.push(...pathPatterns, ...pathPatterns);
    const whereClause = [
      filterClause,
      SessionSearch.jsonArrayLikeClause(['o.files_read', 'o.files_modified'], pathPatterns.length),
    ].filter(Boolean).join(' AND ');
    const orderClause = `${this.buildOrderClause(orderBy, false)}, o.id ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;

    const observationsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${whereClause}
      ${orderClause}
      ${paginationSql}
    `;

    if (!isFolder) params.push(limit, offset);

    const observationStatement = this.db.prepare(observationsSql);
    const observations = isFolder
      ? pageMatchingRows<ObservationSearchResult>(
          observationStatement,
          params,
          obs => this.hasDirectChildFile(obs, filePath),
          { limit, offset },
        )
      : observationStatement.all(...params) as ObservationSearchResult[];

    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type; 

    const baseConditions: string[] = [];
    // Gate P2-16 — summaries merged into the project (an adopted worktree's)
    // count, as they do for observations above and on every other read path.
    const sessionProjects = scopedProjects(sessionFilters);
    if (sessionProjects.length > 0) {
      const scope = projectScopeSql('s', sessionProjects, { includeMerged: true });
      baseConditions.push(scope.sql);
      sessionParams.push(...scope.params);
    }

    if (sessionFilters.platformSource) {
      baseConditions.push(
        `COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`
      );
      sessionParams.push(normalizePlatformSource(sessionFilters.platformSource));
    }

    if (sessionFilters.dateRange) {
      const { start, end } = sessionFilters.dateRange;
      if (start) {
        baseConditions.push('s.created_at_epoch >= ?');
        sessionParams.push(resolveDateBound(start, 'start'));
      }
      if (end) {
        baseConditions.push('s.created_at_epoch <= ?');
        sessionParams.push(resolveDateBound(end, 'end'));
      }
    }

    baseConditions.push(SessionSearch.jsonArrayLikeClause(['s.files_read', 's.files_edited'], pathPatterns.length));
    sessionParams.push(...pathPatterns, ...pathPatterns);

    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}
      ${paginationSql}
    `;

    if (!isFolder) sessionParams.push(limit, offset);

    const sessionStatement = this.db.prepare(sessionsSql);
    const sessions = isFolder
      ? pageMatchingRows<SessionSummarySearchResult>(
          sessionStatement,
          sessionParams,
          row => this.hasDirectChildFileSession(row, filePath),
          { limit, offset },
        )
      : sessionStatement.all(...sessionParams) as SessionSummarySearchResult[];

    return { observations, sessions };
  }

  findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    const typeFilters = { ...filters, type };
    const filterClause = this.buildFilterClause(typeFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  searchUserPrompts(query: string | undefined, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    const baseConditions: string[] = [];
    const projects = scopedProjects(filters);
    if (projects.length > 0) {
      const scope = projectScopeSql('s', projects, { includeMerged: false });
      baseConditions.push(scope.sql);
      params.push(...scope.params);
    }

    if (filters.platformSource) {
      baseConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(filters.platformSource));
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        baseConditions.push('up.created_at_epoch >= ?');
        params.push(resolveDateBound(start, 'start'));
      }
      if (end) {
        baseConditions.push('up.created_at_epoch <= ?');
        params.push(resolveDateBound(end, 'end'));
      }
    }

    if (!query) {
      if (baseConditions.length === 0) {
        // No query text and no filters: nothing to match, so return an empty
        // result set rather than treating a benign empty search as an error.
        return [];
      }

      const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY up.created_at_epoch ASC, up.id ASC'
        : 'ORDER BY up.created_at_epoch DESC, up.id DESC';

      const sql = `
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
    baseConditions.push("up.prompt_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapedQuery}%`);

    const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY up.created_at_epoch ASC, up.id ASC'
      : 'ORDER BY up.created_at_epoch DESC, up.id DESC';

    const sql = `
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
  }

  close(): void {
    this.db.close();
  }
}
