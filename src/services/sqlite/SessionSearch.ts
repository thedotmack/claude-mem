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
  ObservationRow,
  UserPromptRow
} from './types.js';

/**
 * Search interface for session-based memory
 * Provides filter-only structured queries for sessions, observations, and user prompts
 * Vector search is handled by ChromaDB - this class only supports filtering without query text
 */
export class SessionSearch {
  private db: Database;

  constructor(dbPath?: string) {
    if (!dbPath) {
      ensureDir(DATA_DIR);
      dbPath = DB_PATH;
    }
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode = WAL');

    // Ensure FTS tables exist
    this.ensureFTSTables();
  }

  /**
   * Ensure FTS5 tables exist (backward compatibility only - no longer used for search)
   *
   * FTS5 tables are maintained for backward compatibility but not used for search.
   * Vector search (Chroma) is now the primary search mechanism.
   *
   * Retention Rationale:
   * - Prevents breaking existing installations with FTS5 tables
   * - Allows graceful migration path for users
   * - Tables maintained but search paths removed
   * - Triggers still fire to keep tables synchronized
   *
   * FTS5 may be unavailable on some platforms (e.g., Bun on Windows #791).
   * When unavailable, we skip FTS table creation — search falls back to
   * ChromaDB (vector) and LIKE queries (structured filters) which are unaffected.
   *
   * TODO: Remove FTS5 infrastructure in future major version (v7.0.0)
   */
  private ensureFTSTables(): void {
    // Check if FTS tables already exist
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) {
      // Already migrated
      return;
    }

    // Runtime check: verify FTS5 is available before attempting to create tables.
    // bun:sqlite on Windows may not include the FTS5 extension (#791).
    if (!this.isFts5Available()) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    try {
      // Create observations_fts virtual table
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

      // Populate with existing data
      this.db.run(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `);

      // Create triggers for observations
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;
      `);

      // Create session_summaries_fts virtual table
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

      // Populate with existing data
      this.db.run(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `);

      // Create triggers for session_summaries
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;
      `);

      logger.info('DB', 'FTS5 tables created successfully');
    } catch (error) {
      // FTS5 creation failed at runtime despite probe succeeding — degrade gracefully
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error as Error);
    }
  }

  /**
   * Probe whether the FTS5 extension is available in the current SQLite build.
   * Creates and immediately drops a temporary FTS5 table.
   */
  private isFts5Available(): boolean {
    try {
      this.db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      this.db.run('DROP TABLE _fts5_probe');
      return true;
    } catch {
      return false;
    }
  }


  /**
   * Build WHERE clause for structured filters
   */
  private buildFilterClause(
    filters: SearchFilters,
    params: any[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    // Project filter
    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
    }

    // Type filter (for observations only)
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

    // Date range filter
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

    // Concepts filter (JSON array search)
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

    // Files filter (JSON array search)
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
   * Build ORDER BY clause
   */
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

  /**
   * Search observations using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchObservations(query: string | undefined, options: SearchOptions = {}): ObservationSearchResult[] {
    // FILTER-ONLY PATH: When no query text, query table directly
    // This enables date filtering which Chroma cannot do (requires direct SQLite access)
    if (!query) {
      const params: any[] = [];
      const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        throw new Error('Either query or filters required for search');
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

    // FTS5 search path - used when ChromaDB is not available
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;
    const ftsQuery = query.replace(/['"*]/g, ' ').trim();
    if (!ftsQuery) return [];

    const params: any[] = [ftsQuery];
    let sql = `
      SELECT o.*
      FROM observations o
      JOIN observations_fts fts ON o.id = fts.rowid
      WHERE fts.observations_fts MATCH ?
    `;

    const filterClauses: string[] = [];
    if (filters.project) {
      filterClauses.push('o.project = ?');
      params.push(filters.project);
    }
    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => '?').join(',');
        filterClauses.push(`o.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        filterClauses.push('o.type = ?');
        params.push(filters.type);
      }
    }
    if (filterClauses.length > 0) {
      sql += ` AND ${filterClauses.join(' AND ')}`;
    }

    sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    } catch {
      return [];
    }
  }

  /**
   * Search session summaries using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchSessions(query: string | undefined, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // FILTER-ONLY PATH: When no query text, query session_summaries table directly
    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        throw new Error('Either query or filters required for search');
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

    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  /**
   * Find observations by concept tag
   */
  findByConcept(concept: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add concept to filters
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

  /**
   * Check if an observation has any files that are direct children of the folder
   */
  private hasDirectChildFile(obs: ObservationSearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch {}
      return false;
    };

    return checkFiles(obs.files_modified) || checkFiles(obs.files_read);
  }

  /**
   * Check if a session has any files that are direct children of the folder
   */
  private hasDirectChildFileSession(session: SessionSummarySearchResult, folderPath: string): boolean {
    const checkFiles = (filesJson: string | null): boolean => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some(f => isDirectChild(f, folderPath));
        }
      } catch {}
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  /**
   * Find observations and summaries by file path
   * When isFolder=true, only returns results with files directly in the folder (not subfolders)
   */
  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;

    // Query more results if we're filtering to direct children
    const queryLimit = isFolder ? limit * 3 : limit;

    // Add file to filters
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

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // For session summaries, search files_read and files_edited
    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type; // Remove type filter for sessions

    const baseConditions: string[] = [];
    if (sessionFilters.project) {
      baseConditions.push('s.project = ?');
      sessionParams.push(sessionFilters.project);
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

    // File condition
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

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  /**
   * Find observations by type
   */
  findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add type to filters
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

  /**
   * Search user prompts using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchUserPrompts(query: string | undefined, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build filter conditions (join with sdk_sessions for project filtering)
    const baseConditions: string[] = [];
    if (filters.project) {
      baseConditions.push('s.project = ?');
      params.push(filters.project);
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

    // FILTER-ONLY PATH: When no query text, query user_prompts table directly
    if (!query) {
      if (baseConditions.length === 0) {
        throw new Error('Either query or filters required for search');
      }

      const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY up.created_at_epoch ASC'
        : 'ORDER BY up.created_at_epoch DESC';

      const sql = `
        SELECT up.*
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  /**
   * Get all prompts for a session by content_session_id
   */
  getUserPromptsBySession(contentSessionId: string): UserPromptRow[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        content_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY prompt_number ASC
    `);

    return stmt.all(contentSessionId) as UserPromptRow[];
  }

  /**
   * Rank observations by temporal decay score.
   * Half-life scales with importance (1-10): 18d at imp=1, 90d at imp=5, 180d at imp=10.
   * Access count and staleness also factor in.
   */
  rankByTemporalScore(observations: ObservationSearchResult[]): ObservationSearchResult[] {
    if (observations.length === 0) return observations;

    const now = Date.now() / 1000;

    return observations
      .map(obs => {
        const importance = Math.min(10, Math.max(1, (obs as any).importance ?? 5));
        const halfLifeDays = 90 * (importance / 5); // 18d at imp=1, 90d at imp=5, 180d at imp=10
        const lambda = Math.log(2) / halfLifeDays;
        const createdEpoch = obs.created_at_epoch / 1000; // created_at_epoch is ms
        const daysSince = Math.max(0, (now - createdEpoch) / 86400);
        const decayFactor = Math.exp(-lambda * daysSince);
        const accessBoost = Math.log1p((obs as any).access_count ?? 0) * 0.1;
        const stalenessPenalty = (obs as any).is_stale ? 0.1 : 1.0;
        const score = decayFactor * (1 + accessBoost) * stalenessPenalty;

        return { obs, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ obs }) => obs);
  }

  /**
   * Update last_accessed_at and increment access_count for a set of observation IDs.
   */
  updateAccessTracking(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE observations SET last_accessed_at = ?, access_count = COALESCE(access_count, 0) + 1 WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  }

  /**
   * Detect semantic drift in concept clusters.
   * Flags clusters where old memories are unaccessed or heavily stale,
   * suggesting the project has moved on and those memories may be outdated.
   */
  detectDrift(project?: string): {
    driftedConcepts: Array<{
      project: string;
      concept: string;
      totalCount: number;
      recentCount: number;
      oldCount: number;
      unaccessedOld: number;
      staleCount: number;
      stalePct: number;
      signal: 'high-stale' | 'likely-outdated' | 'monitor';
    }>;
    summary: string;
  } {
    const thirtyDaysAgoMs = Date.now() - 30 * 86400 * 1000;

    let sql = `
      WITH concept_stats AS (
        SELECT
          o.project,
          je.value as concept,
          COUNT(*) as total_count,
          SUM(CASE WHEN o.created_at_epoch > ? THEN 1 ELSE 0 END) as recent_count,
          SUM(CASE WHEN o.created_at_epoch <= ? THEN 1 ELSE 0 END) as old_count,
          SUM(CASE WHEN o.created_at_epoch <= ? AND COALESCE(o.access_count, 0) = 0 THEN 1 ELSE 0 END) as unaccessed_old,
          SUM(CASE WHEN o.is_stale = 1 THEN 1 ELSE 0 END) as stale_count
        FROM observations o, json_each(o.concepts) je
        WHERE o.concepts IS NOT NULL
          AND o.concepts != '[]'
          AND o.concepts != 'null'
          AND json_valid(o.concepts)
    `;

    const params: (string | number)[] = [thirtyDaysAgoMs, thirtyDaysAgoMs, thirtyDaysAgoMs];

    if (project) {
      sql += ` AND o.project = ?`;
      params.push(project);
    }

    sql += `
        GROUP BY o.project, je.value
        HAVING total_count >= 2
      )
      SELECT
        project, concept, total_count, recent_count, old_count, unaccessed_old, stale_count,
        ROUND(CAST(stale_count AS REAL) / total_count * 100) as stale_pct,
        CASE
          WHEN CAST(stale_count AS REAL) / total_count > 0.3 THEN 'high-stale'
          WHEN recent_count > 0 AND old_count > 0
            AND CAST(unaccessed_old AS REAL) / old_count > 0.5 THEN 'likely-outdated'
          ELSE 'monitor'
        END as signal
      FROM concept_stats
      WHERE
        (CAST(stale_count AS REAL) / total_count > 0.3)
        OR (recent_count > 0 AND old_count > 0 AND CAST(unaccessed_old AS REAL) / NULLIF(old_count, 0) > 0.5)
      ORDER BY stale_pct DESC, unaccessed_old DESC
      LIMIT 20
    `;

    let rows: any[] = [];
    try {
      rows = this.db.prepare(sql).all(...params) as any[];
    } catch {
      return { driftedConcepts: [], summary: 'Drift check unavailable (concepts column may be empty).' };
    }

    const driftedConcepts = rows.map(r => ({
      project: r.project as string,
      concept: r.concept as string,
      totalCount: r.total_count as number,
      recentCount: r.recent_count as number,
      oldCount: r.old_count as number,
      unaccessedOld: r.unaccessed_old as number,
      staleCount: r.stale_count as number,
      stalePct: r.stale_pct as number,
      signal: r.signal as 'high-stale' | 'likely-outdated' | 'monitor',
    }));

    const highStale = driftedConcepts.filter(c => c.signal === 'high-stale');
    const likelyOutdated = driftedConcepts.filter(c => c.signal === 'likely-outdated');

    const summary = driftedConcepts.length === 0
      ? 'No drift detected. All concept clusters appear current.'
      : `Drift detected in ${driftedConcepts.length} concept cluster(s): ${highStale.length} high-stale, ${likelyOutdated.length} likely-outdated. Consider using contradict() on stale memories in flagged clusters.`;

    return { driftedConcepts, summary };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
