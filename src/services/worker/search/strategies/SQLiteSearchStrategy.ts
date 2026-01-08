/**
 * SQLiteSearchStrategy - Direct SQLite queries for filter-only searches
 *
 * This strategy handles searches without query text (filter-only):
 * - Date range filtering
 * - Project filtering
 * - Type filtering
 * - Concept/file filtering
 *
 * Used when: No query text is provided, or as a fallback when Chroma fails
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';

export class SQLiteSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'sqlite';

  constructor(private sessionSearch: SessionSearch) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle filter-only queries (no query text)
    // Also used as fallback when Chroma is unavailable
    return !options.query || options.strategyHint === 'sqlite';
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      offset = 0,
      project,
      dateRange,
      orderBy = 'date_desc'
    } = options;

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    const baseOptions = { limit, offset, orderBy, project, dateRange };

    logger.debug('SEARCH', 'SQLiteSearchStrategy: Filter-only query', {
      searchType,
      hasDateRange: !!dateRange,
      hasProject: !!project
    });

    try {
      if (searchObservations) {
        const obsOptions = {
          ...baseOptions,
          type: obsType,
          concepts,
          files
        };
        observations = this.sessionSearch.searchObservations(undefined, obsOptions);
      }

      if (searchSessions) {
        sessions = this.sessionSearch.searchSessions(undefined, baseOptions);
      }

      if (searchPrompts) {
        prompts = this.sessionSearch.searchUserPrompts(undefined, baseOptions);
      }

      logger.debug('SEARCH', 'SQLiteSearchStrategy: Results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: false,
        fellBack: false,
        strategy: 'sqlite'
      };

    } catch (error) {
      logger.error('SEARCH', 'SQLiteSearchStrategy: Search failed', {}, error as Error);
      return this.emptyResult('sqlite');
    }
  }

  /**
   * Find observations by concept (used by findByConcept tool)
   */
  findByConcept(concept: string, options: StrategySearchOptions): ObservationSearchResult[] {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByConcept(concept, { limit, project, dateRange, orderBy });
  }

  /**
   * Find observations by type (used by findByType tool)
   */
  findByType(type: string | string[], options: StrategySearchOptions): ObservationSearchResult[] {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByType(type as any, { limit, project, dateRange, orderBy });
  }

  /**
   * Find observations and sessions by file path (used by findByFile tool)
   */
  findByFile(filePath: string, options: StrategySearchOptions): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByFile(filePath, { limit, project, dateRange, orderBy });
  }
}
