import { Database } from 'bun:sqlite';
import { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isDirectChild } from '../../shared/path-utils.js';
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
import { applySqliteConnectionPragmas } from './connection.js';

/**
 * Code-point ranges of the scripts FTS5's unicode61 tokenizer cannot segment: Thai and Lao,
 * Myanmar, Khmer, Hiragana/Katakana, Bopomofo and Hangul compatibility jamo, the CJK
 * ideograph blocks, and Hangul syllables. See {@link SessionSearch.UNSEGMENTED_SCRIPT}.
 */
const UNSEGMENTED_SCRIPT_RANGES =
  '\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';

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

export class SessionSearch {
  private db: Database;

  constructor(dbPathOrDb: string | Database = DB_PATH) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      ensureDir(DATA_DIR);
      this.db = new Database(dbPathOrDb);
    }

    applySqliteConnectionPragmas(this.db);

    this._fts5Available = this.isFts5Available();

    this.ensureFTSTables();
  }

  private _fts5Available: boolean;

  private ensureFTSTables(): void {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) {
      return;
    }

    if (!this.isFts5Available()) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    try {
      this.createFTSTablesAndTriggers();
      logger.info('DB', 'FTS5 tables created successfully');
    } catch (error) {
      this._fts5Available = false;
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error instanceof Error ? error : undefined);
    }
  }

  private isFts5Available(): boolean {
    try {
      this.db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      this.db.run('DROP TABLE _fts5_probe');
      return true;
    } catch (error) {
      logger.debug('DB', 'FTS5 probe failed — FTS5 unavailable on this platform', undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private createFTSTablesAndTriggers(): void {
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

  private buildFilterClause(
    filters: SearchFilters,
    params: any[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
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
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(endEpoch);
      }
    }

    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptConditions = concepts.map(() => {
        return `EXISTS (SELECT 1 FROM json_each(${tableAlias}.concepts) WHERE value = ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() => {
        return `(
          EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_modified) WHERE value LIKE ?)
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          params.push(`%${file}%`, `%${file}%`);
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
   * Build the substring predicate used when the index cannot represent the query. Each
   * term must appear in at least one column, and every term must appear somewhere. The
   * escaping matches {@link searchUserPrompts}, which has always searched by substring.
   */
  private static buildSubstringClause(query: string, columns: string[]): { clause: string; params: string[] } {
    const terms: string[] = query.match(SessionSearch.UNSEGMENTED_RUN) ?? [];
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

  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance', hasFTS: boolean = true, ftsTable: string = 'observations_fts'): string {
    switch (orderBy) {
      case 'relevance':
        return hasFTS ? `ORDER BY ${ftsTable}.rank ASC` : 'ORDER BY o.created_at_epoch DESC';
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC';
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
      ? 'ORDER BY s.created_at_epoch ASC'
      : 'ORDER BY s.created_at_epoch DESC';

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

    if (this._fts5Available) {
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
      return this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
    }

    logger.warn('DB', 'Text search unavailable: ChromaDB disabled and FTS5 not available');
    return [];
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
        ? 'ORDER BY s.created_at_epoch ASC'
        : 'ORDER BY s.created_at_epoch DESC';

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

    if (this._fts5Available) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC'
        : orderBy === 'date_desc'
          ? 'ORDER BY s.created_at_epoch DESC'
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
      // No FTS match at all: see searchObservations.
      return this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
    }

    logger.warn('DB', 'Text search unavailable: ChromaDB disabled and FTS5 not available');
    return [];
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
          return files.some(f => isDirectChild(f, folderPath));
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
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug('DB', `Failed to parse files JSON for session summary ${session.id}`, undefined, error instanceof Error ? error : undefined);
      }
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;

    const queryLimit = isFolder ? limit * 3 : limit;

    const fileFilters = { ...filters, files: filePath };
    const filterClause = this.buildFilterClause(fileFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const observationsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(queryLimit, offset);

    let observations = this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type; 

    const baseConditions: string[] = [];
    if (sessionFilters.project) {
      baseConditions.push('s.project = ?');
      sessionParams.push(sessionFilters.project);
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
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('s.created_at_epoch >= ?');
        sessionParams.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('s.created_at_epoch <= ?');
        sessionParams.push(endEpoch);
      }
    }

    baseConditions.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`);
    sessionParams.push(`%${filePath}%`, `%${filePath}%`);

    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(queryLimit, offset);

    let sessions = this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

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
    if (filters.project) {
      baseConditions.push('s.project = ?');
      params.push(filters.project);
    }

    if (filters.platformSource) {
      baseConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(filters.platformSource));
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('up.created_at_epoch >= ?');
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('up.created_at_epoch <= ?');
        params.push(endEpoch);
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
        ? 'ORDER BY up.created_at_epoch ASC'
        : 'ORDER BY up.created_at_epoch DESC';

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
      ? 'ORDER BY up.created_at_epoch ASC'
      : 'ORDER BY up.created_at_epoch DESC';

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
