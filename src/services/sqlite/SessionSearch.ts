import { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isDirectChild } from '../../shared/path-utils.js';
import type { DbAdapter } from './adapter.js';
import { queryAll, exec } from './adapter.js';
import { createDbAdapter } from './adapters/libsql-adapter.js';
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
  private db: DbAdapter;

  private constructor(db: DbAdapter) {
    this.db = db;
  }

  /**
   * Create a SessionSearch instance (async factory)
   */
  static async create(dbPath?: string): Promise<SessionSearch> {
    if (!dbPath) {
      ensureDir(DATA_DIR);
      dbPath = DB_PATH;
    }
    const db = await createDbAdapter(dbPath);
    await db.execute('PRAGMA journal_mode = WAL');

    const instance = new SessionSearch(db);
    await instance.ensureFTSTables();
    return instance;
  }

  /**
   * Ensure FTS5 tables exist (backward compatibility only - no longer used for search)
   */
  private async ensureFTSTables(): Promise<void> {
    const tables = await queryAll<TableNameRow>(this.db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'");
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) return;

    if (!(await this.isFts5Available())) {
      logger.warn('DB', 'FTS5 not available on this platform — skipping FTS table creation (search uses ChromaDB)');
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    try {
      await this.db.executeScript(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title, subtitle, narrative, text, facts, concepts,
          content='observations', content_rowid='id'
        )
      `);

      await this.db.execute(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations
      `);

      await this.db.executeScript(`
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
        END
      `);

      await this.db.executeScript(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request, investigated, learned, completed, next_steps, notes,
          content='session_summaries', content_rowid='id'
        )
      `);

      await this.db.execute(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries
      `);

      await this.db.executeScript(`
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
        END
      `);

      logger.info('DB', 'FTS5 tables created successfully');
    } catch (error) {
      logger.warn('DB', 'FTS5 table creation failed — search will use ChromaDB and LIKE queries', {}, error as Error);
    }
  }

  /**
   * Probe whether the FTS5 extension is available
   */
  private async isFts5Available(): Promise<boolean> {
    try {
      await this.db.execute('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      await this.db.execute('DROP TABLE _fts5_probe');
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

    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
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
      const conceptConditions = concepts.map(() =>
        `EXISTS (SELECT 1 FROM json_each(${tableAlias}.concepts) WHERE value = ?)`
      );
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() =>
        `(EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_modified) WHERE value LIKE ?))`
      );
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          params.push(`%${file}%`, `%${file}%`);
        });
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
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

  async searchObservations(query: string | undefined, options: SearchOptions = {}): Promise<ObservationSearchResult[]> {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    if (!query) {
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
      return queryAll<ObservationSearchResult>(this.db, sql, params);
    }

    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  async searchSessions(query: string | undefined, options: SearchOptions = {}): Promise<SessionSummarySearchResult[]> {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

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
      return queryAll<SessionSummarySearchResult>(this.db, sql, params);
    }

    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  async findByConcept(concept: string, options: SearchOptions = {}): Promise<ObservationSearchResult[]> {
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
    return queryAll<ObservationSearchResult>(this.db, sql, params);
  }

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

  async findByFile(filePath: string, options: SearchOptions = {}): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  }> {
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
    let observations = await queryAll<ObservationSearchResult>(this.db, observationsSql, params);

    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // Session summaries
    const sessionParams: any[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type;

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
    let sessions = await queryAll<SessionSummarySearchResult>(this.db, sessionsSql, sessionParams);

    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  async findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): Promise<ObservationSearchResult[]> {
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
    return queryAll<ObservationSearchResult>(this.db, sql, params);
  }

  async searchUserPrompts(query: string | undefined, options: SearchOptions = {}): Promise<UserPromptSearchResult[]> {
    const params: any[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

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
      return queryAll<UserPromptSearchResult>(this.db, sql, params);
    }

    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  async getUserPromptsBySession(contentSessionId: string): Promise<UserPromptRow[]> {
    return queryAll<UserPromptRow>(this.db, `
      SELECT id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY prompt_number ASC
    `, [contentSessionId]);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
