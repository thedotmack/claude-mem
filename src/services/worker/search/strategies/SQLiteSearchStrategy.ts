
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

export class SQLiteSearchStrategy {
  constructor(private sessionSearch: SessionSearch) {}

  private emptyResult(strategy: 'sqlite'): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: false,
      strategy
    };
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      offset = 0,
      project,
      platformSource,
      dateRange,
      orderBy = 'date_desc'
    } = options;

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    const baseOptions = { limit, offset, orderBy, project, platformSource, dateRange };

    logger.debug('SEARCH', 'SQLiteSearchStrategy: SQLite query', {
      searchType,
      hasQuery: !!query,
      hasDateRange: !!dateRange,
      hasProject: !!project
    });

    const obsOptions = searchObservations ? { ...baseOptions, type: obsType, concepts, files } : null;

    try {
      return this.executeSqliteSearch(query, obsOptions, searchSessions, searchPrompts, baseOptions);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'SQLiteSearchStrategy: Search failed', {}, errorObj);
      return this.emptyResult('sqlite');
    }
  }

  private executeSqliteSearch(
    query: string | undefined,
    obsOptions: Record<string, any> | null,
    searchSessions: boolean,
    searchPrompts: boolean,
    baseOptions: Record<string, any>
  ): StrategySearchResult {
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    if (obsOptions) {
      observations = this.sessionSearch.searchObservations(query, obsOptions);
    }
    if (searchSessions) {
      sessions = this.sessionSearch.searchSessions(query, baseOptions);
    }
    if (searchPrompts) {
      prompts = this.sessionSearch.searchUserPrompts(query, baseOptions);
    }

    return {
      results: { observations, sessions, prompts },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  findByConcept(concept: string, options: StrategySearchOptions): ObservationSearchResult[] {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByConcept(concept, { limit, project, platformSource, dateRange, orderBy });
  }

  findByType(type: string | string[], options: StrategySearchOptions): ObservationSearchResult[] {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByType(type as any, { limit, project, platformSource, dateRange, orderBy });
  }

  findByFile(filePath: string, options: StrategySearchOptions): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy = 'date_desc' } = options;
    return this.sessionSearch.findByFile(filePath, { limit, project, platformSource, dateRange, orderBy });
  }
}
