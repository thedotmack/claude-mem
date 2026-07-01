
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ChromaMetadata,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';

export class ChromaSearchStrategy {
  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore
  ) {}

  private emptyResult(strategy: 'chroma'): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: true,
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
      project,
      platformSource,
      orderBy = 'date_desc'
    } = options;

    if (!query) {
      return this.emptyResult('chroma');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    const whereFilter = this.buildWhereFilter(searchType, project, platformSource);

    logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });

    return await this.executeChromaSearch(query, whereFilter, {
      searchObservations, searchSessions, searchPrompts,
      obsType, concepts, files, orderBy, limit, project, platformSource
    });
  }

  private async executeChromaSearch(
    query: string,
    whereFilter: Record<string, any> | undefined,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
      obsType?: string | string[];
      concepts?: string | string[];
      files?: string | string[];
      orderBy: 'relevance' | 'date_desc' | 'date_asc';
      limit: number;
      project?: string;
      platformSource?: string;
    }
  ): Promise<StrategySearchResult> {
    const chromaResults = await this.chromaSync.queryChroma(
      query,
      SEARCH_CONSTANTS.CHROMA_BATCH_SIZE,
      whereFilter
    );

    if (chromaResults.ids.length === 0) {
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: true,
        strategy: 'chroma'
      };
    }

    const recentItems = this.filterByRecency(chromaResults);
    const categorized = this.categorizeByDocType(recentItems, options);

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    const sqlOrderBy = options.orderBy;

    if (categorized.obsIds.length > 0) {
      const obsOptions = {
        type: options.obsType,
        concepts: options.concepts,
        files: options.files,
        orderBy: sqlOrderBy,
        limit: options.limit,
        project: options.project,
        platformSource: options.platformSource
      };
      observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
    }

    if (categorized.sessionIds.length > 0) {
      sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
        orderBy: sqlOrderBy,
        limit: options.limit,
        project: options.project,
        platformSource: options.platformSource
      });
    }

    if (categorized.promptIds.length > 0) {
      prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
        orderBy: sqlOrderBy,
        limit: options.limit,
        project: options.project,
        platformSource: options.platformSource
      });
    }

    return {
      results: { observations, sessions, prompts },
      usedChroma: true,
      strategy: 'chroma'
    };
  }

  private buildWhereFilter(searchType: string, project?: string, platformSource?: string): Record<string, any> | undefined {
    const filters: Array<Record<string, any>> = [];

    switch (searchType) {
      case 'observations':
        filters.push({ doc_type: 'observation' });
        break;
      case 'sessions':
        filters.push({ doc_type: 'session_summary' });
        break;
      case 'prompts':
        filters.push({ doc_type: 'user_prompt' });
        break;
      default:
        break;
    }

    if (project) {
      filters.push({ project });
    }

    if (platformSource) {
      filters.push({ platform_source: normalizePlatformSource(platformSource) });
    }

    if (filters.length === 0) {
      return undefined;
    }
    if (filters.length === 1) {
      return filters[0];
    }
    return { $and: filters };
  }

  private filterByRecency(chromaResults: {
    ids: number[];
    metadatas: ChromaMetadata[];
  }): Array<{ id: number; meta: ChromaMetadata }> {
    const cutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;

    const metadataByIdMap = new Map<number, ChromaMetadata>();
    for (const meta of chromaResults.metadatas) {
      if (meta?.sqlite_id !== undefined && !metadataByIdMap.has(meta.sqlite_id)) {
        metadataByIdMap.set(meta.sqlite_id, meta);
      }
    }

    return chromaResults.ids
      .map(id => ({
        id,
        meta: metadataByIdMap.get(id) as ChromaMetadata
      }))
      .filter(item => item.meta && item.meta.created_at_epoch > cutoff);
  }

  private categorizeByDocType(
    items: Array<{ id: number; meta: ChromaMetadata }>,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): { obsIds: number[]; sessionIds: number[]; promptIds: number[] } {
    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];

    for (const item of items) {
      const docType = item.meta?.doc_type;
      if (docType === 'observation' && options.searchObservations) {
        obsIds.push(item.id);
      } else if (docType === 'session_summary' && options.searchSessions) {
        sessionIds.push(item.id);
      } else if (docType === 'user_prompt' && options.searchPrompts) {
        promptIds.push(item.id);
      }
    }

    return { obsIds, sessionIds, promptIds };
  }
}
