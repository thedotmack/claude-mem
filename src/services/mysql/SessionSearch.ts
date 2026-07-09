/**
 * MySQL SessionSearch - Async wrapper for MySQL search operations
 *
 * Provides a class-based interface matching SQLite SessionSearch API,
 * but using async methods since MySQL is inherently async.
 *
 * NOTE: MySQL uses JSON_CONTAINS for JSON array searches instead of SQLite's json_each.
 */

import type { MySQLDatabase } from './Database.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
} from '../sqlite/types.js';
import { AppError } from '../server/ErrorHandler.js';

export class SessionSearch {
  private db: MySQLDatabase;

  private static readonly MISSING_SEARCH_INPUT_MESSAGE = 'Either query or filters required for search';

  constructor(db: MySQLDatabase) {
    this.db = db;
  }

  /**
   * Ensure FTS tables exist (MySQL doesn't have FTS5, this is a no-op)
   * Kept for API compatibility with SQLite SessionSearch
   */
  ensureFTSTables(): void {
    // MySQL doesn't have SQLite FTS5 - this is a no-op for compatibility
    logger.info('DB', 'MySQL does not support FTS5, ensureFTSTables is a no-op');
  }

  /**
   * Check if FTS5 is available (MySQL doesn't have FTS5, always returns false)
   * Kept for API compatibility with SQLite SessionSearch
   */
  isFts5Available(): boolean {
    // MySQL doesn't have SQLite FTS5 extension
    return false;
  }

  /**
   * Build WHERE clause for structured filters (MySQL version)
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

    // Concepts filter (MySQL JSON_CONTAINS)
    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptConditions = concepts.map(() => {
        return `JSON_CONTAINS(${tableAlias}.concepts, ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        concepts.forEach((c: string) => params.push(JSON.stringify(c)));
      }
    }

    // Files filter (MySQL JSON_CONTAINS)
    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() => {
        return `(
          JSON_CONTAINS(${tableAlias}.files_read, ?)
          OR JSON_CONTAINS(${tableAlias}.files_modified, ?)
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach((file: string) => {
          params.push(JSON.stringify(file), JSON.stringify(file));
        });
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance', hasFTS: boolean = true): string {
    switch (orderBy) {
      case 'relevance':
        return 'ORDER BY o.created_at_epoch DESC'; // MySQL doesn't have FTS rank
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC';
      default:
        return 'ORDER BY o.created_at_epoch DESC';
    }
  }

  /**
   * Search observations using filter-only query (no FTS in MySQL)
   */
  async searchObservations(query: string | undefined, options: SearchOptions = {}): Promise<ObservationSearchResult[]> {
    const params: any[] = [];
    const { orderBy = 'relevance', ...filters } = options;
    const limit = Number(options.limit) || 50;
    const offset = Number(options.offset) || 0;

    // FILTER-ONLY PATH: When no query text, query table directly
    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
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
      return await this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    }

    // Keyword search fallback: use LIKE on title and narrative fields
    const likePattern = `%${query}%`;
    const queryConditions = ['(o.title LIKE ? OR o.narrative LIKE ? OR o.`text` LIKE ?)'];
    params.push(likePattern, likePattern, likePattern);

    const filterClause = this.buildFilterClause(filters, params, 'o');
    const whereClause = filterClause
      ? `${queryConditions[0]} AND ${filterClause}`
      : queryConditions[0];

    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    return await this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Search session summaries using filter-only query
   */
  async searchSessions(query: string | undefined, options: SearchOptions = {}): Promise<SessionSummarySearchResult[]> {
    const params: any[] = [];
    const { orderBy = 'relevance', ...filters } = options;
    const limit = Number(options.limit) || 50;
    const offset = Number(options.offset) || 0;

    // FILTER-ONLY PATH: When no query text, query session_summaries table directly
    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
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
      return await this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
    }

    // Keyword search fallback: use LIKE on request and learned fields
    const likePattern = `%${query}%`;
    const queryConditions = ['(s.`request` LIKE ? OR s.learned LIKE ? OR s.investigated LIKE ?)'];
    params.push(likePattern, likePattern, likePattern);

    const filterOptions = { ...filters };
    delete filterOptions.type;
    const filterClause = this.buildFilterClause(filterOptions, params, 's');
    const whereClause = filterClause
      ? `${queryConditions[0]} AND ${filterClause}`
      : queryConditions[0];

    const orderClause = orderBy === 'date_asc'
      ? 'ORDER BY s.created_at_epoch ASC'
      : 'ORDER BY s.created_at_epoch DESC';

    const sql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    return await this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
  }

  /**
   * Find observations by concept tag
   */
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
    return await this.db.prepare(sql).all(...params) as ObservationSearchResult[];
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
          return files.some(f => this.isDirectChild(f, folderPath));
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
          return files.some(f => this.isDirectChild(f, folderPath));
        }
      } catch {}
      return false;
    };

    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }

  /**
   * Check if a file path is a direct child of a folder
   */
  private isDirectChild(filePath: string, folderPath: string): boolean {
    // Normalize paths
    const normalizedFolder = folderPath.replace(/\/+$/, '');
    const normalizedFile = filePath.replace(/\/+$/, '');

    // Check if file starts with folder and has exactly one more path component
    if (!normalizedFile.startsWith(normalizedFolder + '/')) {
      return false;
    }

    const relativePath = normalizedFile.slice(normalizedFolder.length + 1);
    // Direct child means no additional slashes in the relative path
    return !relativePath.includes('/');
  }

  /**
   * Find observations and summaries by file path
   */
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
    let observations = await this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // For session summaries
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

    // File condition (MySQL JSON_CONTAINS)
    baseConditions.push(`(
      JSON_CONTAINS(s.files_read, ?)
      OR JSON_CONTAINS(s.files_edited, ?)
    )`);
    sessionParams.push(JSON.stringify(filePath), JSON.stringify(filePath));

    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(queryLimit, offset);
    let sessions = await this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  /**
   * Find observations by type
   */
  async findByType(
    type: string | string[],
    options: SearchOptions = {}
  ): Promise<ObservationSearchResult[]> {
    const params: any[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder: _isFolder, ...filters } = options;

    const typeFilters = { ...filters, type } as SearchFilters;
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
    return await this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Search user prompts using filter-only query
   */
  async searchUserPrompts(query: string | undefined, options: SearchOptions = {}): Promise<UserPromptSearchResult[]> {
    const params: any[] = [];
    const { orderBy = 'relevance', ...filters } = options;
    const limit = Number(options.limit) || 20;
    const offset = Number(options.offset) || 0;

    // Build filter conditions
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
        throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
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
      return await this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    // Keyword search fallback: use LIKE on prompt_text
    const likePattern = `%${query}%`;
    baseConditions.push('up.prompt_text LIKE ?');
    params.push(likePattern);

    if (baseConditions.length === 0) {
      throw new AppError(SessionSearch.MISSING_SEARCH_INPUT_MESSAGE, 400, 'INVALID_SEARCH_REQUEST');
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
    return await this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
  }

  /**
   * Get all prompts for a session by content_session_id
   */
  async getUserPromptsBySession(contentSessionId: string): Promise<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }[]> {
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

    return await stmt.all(contentSessionId) as any[];
  }

  /**
   * Close the database connection (owned by ClaudeMemMySQLDatabase, not this class)
   */
  close(): void {
    // MySQL connection is managed by ClaudeMemMySQLDatabase, not SessionSearch
    // This method is kept for API compatibility but does nothing
  }
}