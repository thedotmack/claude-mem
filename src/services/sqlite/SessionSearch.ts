import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
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
 * Provides FTS5 full-text search and structured queries for sessions, observations, and summaries
 */
export class SessionSearch {
  private db: Database.Database;

  constructor(dbPath?: string) {
    if (!dbPath) {
      ensureDir(DATA_DIR);
      dbPath = DB_PATH;
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    // Ensure FTS tables exist
    this.ensureFTSTables();
  }

  /**
   * Ensure FTS5 tables exist (inline migration)
   */
  private ensureFTSTables(): void {
    try {
      // Check if FTS tables already exist
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as any[];
      const hasFTS = tables.some((t: any) => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

      if (hasFTS) {
        // Already migrated
        return;
      }

      console.error('[SessionSearch] Creating FTS5 tables...');

      // Create observations_fts virtual table
      this.db.exec(`
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
      this.db.exec(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `);

      // Create triggers for observations
      this.db.exec(`
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
      this.db.exec(`
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
      this.db.exec(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `);

      // Create triggers for session_summaries
      this.db.exec(`
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

      console.error('[SessionSearch] FTS5 tables created successfully');
    } catch (error: any) {
      console.error('[SessionSearch] FTS migration error:', error.message);
    }
  }

  /**
   * Escape FTS5 special characters in user input
   * 
   * FTS5 uses double quotes for phrase searches and treats certain characters
   * as operators (*, AND, OR, NOT, parentheses, etc.). To prevent injection,
   * we wrap user input in double quotes and escape internal quotes by doubling them.
   * This converts any user input into a safe phrase search.
   * 
   * @param text - User input to escape for FTS5 MATCH queries
   * @returns Safely escaped FTS5 query string
   */
  private escapeFTS5(text: string): string {
    // Escape internal double quotes by doubling them (FTS5 standard)
    // Then wrap the entire string in double quotes for phrase search
    return `"${text.replace(/"/g, '""')}"`;
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
   * Search observations using FTS5 full-text search
   */
  searchObservations(query: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build FTS5 match query
    const ftsQuery = this.escapeFTS5(query);
    params.push(ftsQuery);

    // Build filter conditions
    const filterClause = this.buildFilterClause(filters, params, 'o');
    const whereClause = filterClause ? `AND ${filterClause}` : '';

    // Build ORDER BY
    const orderClause = this.buildOrderClause(orderBy, true);

    // Main query with FTS5
    const sql = `
      SELECT
        o.*,
        observations_fts.rank as rank
      FROM observations o
      JOIN observations_fts ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const results = this.db.prepare(sql).all(...params) as ObservationSearchResult[];

    // Normalize rank to score (0-1, higher is better)
    if (results.length > 0) {
      const minRank = Math.min(...results.map(r => r.rank || 0));
      const maxRank = Math.max(...results.map(r => r.rank || 0));
      const range = maxRank - minRank || 1;

      results.forEach(r => {
        if (r.rank !== undefined) {
          // Invert rank (lower rank = better match) and normalize to 0-1
          r.score = 1 - ((r.rank - minRank) / range);
        }
      });
    }

    return results;
  }

  /**
   * Search session summaries using FTS5 full-text search
   */
  searchSessions(query: string, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build FTS5 match query
    const ftsQuery = this.escapeFTS5(query);
    params.push(ftsQuery);

    // Build filter conditions (without type filter - not applicable to summaries)
    const filterOptions = { ...filters };
    delete filterOptions.type;
    const filterClause = this.buildFilterClause(filterOptions, params, 's');
    const whereClause = filterClause ? `AND ${filterClause}` : '';

    // Note: session_summaries don't have files_read/files_modified in the same way
    // We'll need to adjust the filter clause
    const adjustedWhereClause = whereClause.replace(/files_read/g, 'files_read').replace(/files_modified/g, 'files_edited');

    // Build ORDER BY
    const orderClause = orderBy === 'relevance'
      ? 'ORDER BY session_summaries_fts.rank ASC'
      : orderBy === 'date_asc'
      ? 'ORDER BY s.created_at_epoch ASC'
      : 'ORDER BY s.created_at_epoch DESC';

    // Main query with FTS5
    const sql = `
      SELECT
        s.*,
        session_summaries_fts.rank as rank
      FROM session_summaries s
      JOIN session_summaries_fts ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${adjustedWhereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const results = this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];

    // Normalize rank to score
    if (results.length > 0) {
      const minRank = Math.min(...results.map(r => r.rank || 0));
      const maxRank = Math.max(...results.map(r => r.rank || 0));
      const range = maxRank - minRank || 1;

      results.forEach(r => {
        if (r.rank !== undefined) {
          r.score = 1 - ((r.rank - minRank) / range);
        }
      });
    }

    return results;
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
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Find observations and summaries by file path
   */
  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add file to filters
    const fileFilters = { ...filters, files: filePath };
    const filterClause = this.buildFilterClause(fileFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const observationsSql = `
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const observations = this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

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
      SELECT s.*
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(limit, offset);

    const sessions = this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

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
      SELECT o.*
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Search user prompts with full-text search
   */
  searchUserPrompts(query: string, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build FTS5 match query
    const ftsQuery = this.escapeFTS5(query);
    params.push(ftsQuery);

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

    const whereClause = baseConditions.length > 0 ? `AND ${baseConditions.join(' AND ')}` : '';

    // Build ORDER BY
    const orderClause = orderBy === 'relevance'
      ? 'ORDER BY user_prompts_fts.rank ASC'
      : orderBy === 'date_asc'
      ? 'ORDER BY up.created_at_epoch ASC'
      : 'ORDER BY up.created_at_epoch DESC';

    // Main query with FTS5 (join sdk_sessions for project filtering)
    const sql = `
      SELECT
        up.*,
        user_prompts_fts.rank as rank
      FROM user_prompts up
      JOIN user_prompts_fts ON up.id = user_prompts_fts.rowid
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE user_prompts_fts MATCH ?
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const results = this.db.prepare(sql).all(...params) as UserPromptSearchResult[];

    // Normalize rank to score
    if (results.length > 0) {
      const minRank = Math.min(...results.map(r => r.rank || 0));
      const maxRank = Math.max(...results.map(r => r.rank || 0));
      const range = maxRank - minRank || 1;

      results.forEach(r => {
        if (r.rank !== undefined) {
          r.score = 1 - ((r.rank - minRank) / range);
        }
      });
    }

    return results;
  }

  /**
   * Get all prompts for a session by claude_session_id
   */
  getUserPromptsBySession(claudeSessionId: string): UserPromptRow[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        claude_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      FROM user_prompts
      WHERE claude_session_id = ?
      ORDER BY prompt_number ASC
    `);

    return stmt.all(claudeSessionId) as UserPromptRow[];
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
