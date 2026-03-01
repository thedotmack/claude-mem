/**
 * BM25SearchStrategy - FTS5 BM25 keyword search via SQLite
 *
 * This strategy executes full-text keyword search using SQLite's FTS5 extension
 * with BM25 scoring. It operates independently of Chroma/vector search, providing
 * reliable keyword matching even when Chroma is unavailable.
 *
 * BM25 scoring in SQLite FTS5:
 * - Returns NEGATIVE values (more negative = better match)
 * - ORDER BY ASC to get best matches first
 * - Column weights control the importance of each field
 *
 * Used when: Query text is present and keyword/BM25 search is explicitly requested,
 * or as part of a hybrid-blend strategy.
 */

import type { SearchStrategy } from './SearchStrategy.js';
import { BaseSearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import type { SessionSearch } from '../../../sqlite/SessionSearch.js';
import type { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';

export class BM25SearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'bm25';

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      dateRange,
    } = options;

    if (!query) {
      return this.emptyResult('bm25');
    }

    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) {
      return this.emptyResult('bm25');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    const prompts: UserPromptSearchResult[] = [];

    try {
      const db = this.sessionSearch.getDb();

      if (searchObservations) {
        observations = this.searchObservationsFTS(db, sanitized, { limit, project, dateRange });
      }

      if (searchSessions) {
        sessions = this.searchSessionSummariesFTS(db, sanitized, { limit, project, dateRange });
      }

      logger.debug('SEARCH', 'BM25SearchStrategy: Results', {
        query,
        sanitized,
        observations: observations.length,
        sessions: sessions.length,
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: false,
        fellBack: false,
        strategy: 'bm25',
      };

    } catch (error) {
      logger.error('SEARCH', 'BM25SearchStrategy: Search failed', {}, error as Error);
      return this.emptyResult('bm25');
    }
  }

  private buildDateFilters(
    filters: { dateRange?: { start?: string | number; end?: string | number } },
    tableAlias: string
  ): { conditions: string[]; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start !== undefined) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(startEpoch);
      }
      if (end !== undefined) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(endEpoch);
      }
    }

    return { conditions, params };
  }

  private searchObservationsFTS(
    db: ReturnType<SessionSearch['getDb']>,
    sanitizedQuery: string,
    filters: { limit: number; project?: string; dateRange?: { start?: string | number; end?: string | number } }
  ): ObservationSearchResult[] {
    const params: (string | number)[] = [sanitizedQuery];
    const conditions: string[] = [];

    if (filters.project) {
      conditions.push('o.project = ?');
      params.push(filters.project);
    }

    const dateFilters = this.buildDateFilters(filters, 'o');
    conditions.push(...dateFilters.conditions);
    params.push(...dateFilters.params);

    const whereClause = conditions.length > 0
      ? `AND ${conditions.join(' AND ')}`
      : '';

    params.push(filters.limit);

    const sql = `
      SELECT o.*, bm25(observations_fts, 10.0, 5.0, 3.0, 2.0, 1.0, 1.0, 2.0, 1.5) AS bm25_score
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${whereClause}
      ORDER BY bm25_score ASC
      LIMIT ?
    `;

    return db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  private searchSessionSummariesFTS(
    db: ReturnType<SessionSearch['getDb']>,
    sanitizedQuery: string,
    filters: { limit: number; project?: string; dateRange?: { start?: string | number; end?: string | number } }
  ): SessionSummarySearchResult[] {
    const params: (string | number)[] = [sanitizedQuery];
    const conditions: string[] = [];

    if (filters.project) {
      conditions.push('s.project = ?');
      params.push(filters.project);
    }

    const dateFilters = this.buildDateFilters(filters, 's');
    conditions.push(...dateFilters.conditions);
    params.push(...dateFilters.params);

    const whereClause = conditions.length > 0
      ? `AND ${conditions.join(' AND ')}`
      : '';

    params.push(filters.limit);

    const sql = `
      SELECT s.*, bm25(session_summaries_fts, 5.0, 3.0, 3.0, 3.0, 2.0, 1.0) AS bm25_score
      FROM session_summaries_fts
      JOIN session_summaries s ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${whereClause}
      ORDER BY bm25_score ASC
      LIMIT ?
    `;

    return db.prepare(sql).all(...params) as SessionSummarySearchResult[];
  }

  /**
   * Sanitize a user query for safe use as an FTS5 MATCH expression.
   *
   * FTS5 special characters that can cause syntax errors are stripped.
   * Each remaining token is wrapped in double quotes to force exact matching
   * and prevent interpretation as FTS5 operators.
   *
   * Implicit AND semantics: tokens joined with spaces require all to match.
   */
  private sanitizeQuery(query: string): string {
    const tokens = query
      .replace(/['"()*+-]/g, ' ')  // Strip FTS5 special characters
      .split(/\s+/)                   // Split on whitespace
      .filter(t => t.length > 0)      // Remove empty tokens
      .map(t => `"${t}"`);            // Quote each token for exact matching

    return tokens.join(' ');
  }
}
