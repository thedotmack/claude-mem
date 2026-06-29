
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';

export class HybridSearchStrategy {
  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch
  ) {}

  private emptyResult(strategy: 'hybrid'): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: true,
      strategy
    };
  }

  async findByConcept(
    concept: string,
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy } = options;
    const filterOptions = { limit, project, platformSource, dateRange, orderBy };

    logger.debug('SEARCH', 'HybridSearchStrategy: findByConcept', { concept });

    const metadataResults = this.sessionSearch.findByConcept(concept, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    return await this.rankAndHydrate(concept, ids, metadataResults, { limit, project, platformSource, orderBy });
  }

  async findByType(
    type: string | string[],
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy } = options;
    const filterOptions = { limit, project, platformSource, dateRange, orderBy };
    const typeStr = Array.isArray(type) ? type.join(', ') : type;

    logger.debug('SEARCH', 'HybridSearchStrategy: findByType', { type: typeStr });

    const metadataResults = this.sessionSearch.findByType(type as any, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    return await this.rankAndHydrate(typeStr, ids, metadataResults, { limit, project, platformSource, orderBy });
  }

  async findByFile(
    filePath: string,
    options: StrategySearchOptions
  ): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    usedChroma: boolean;
  }> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, platformSource, dateRange, orderBy } = options;
    const filterOptions = { limit, project, platformSource, dateRange, orderBy };

    logger.debug('SEARCH', 'HybridSearchStrategy: findByFile', { filePath });

    const metadataResults = this.sessionSearch.findByFile(filePath, filterOptions);
    const sessions = metadataResults.sessions;

    if (metadataResults.observations.length === 0) {
      return { observations: [], sessions, usedChroma: false };
    }

    const ids = metadataResults.observations.map(obs => obs.id);

    return await this.rankAndHydrateForFile(filePath, ids, metadataResults.observations, { limit, project, platformSource, orderBy }, sessions);
  }

  private async rankAndHydrate(
    queryText: string,
    metadataIds: number[],
    fallbackObservations: ObservationSearchResult[],
    options: { limit: number; project?: string; platformSource?: string; orderBy?: StrategySearchOptions['orderBy'] }
  ): Promise<StrategySearchResult> {
    const chromaResults = await this.chromaSync.queryChroma(
      queryText,
      Math.min(metadataIds.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE),
      this.buildObservationWhereFilter(options.project, options.platformSource)
    );

    const rankedIds = this.intersectWithRanking(metadataIds, chromaResults.ids);

    if (rankedIds.length > 0) {
      const observations = this.sessionStore.getObservationsByIds(rankedIds, {
        orderBy: 'relevance',
        limit: options.limit,
        project: options.project,
        platformSource: options.platformSource
      });
      observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

      return {
        results: { observations, sessions: [], prompts: [] },
        usedChroma: true,
        strategy: 'hybrid'
      };
    }

    if (options.platformSource) {
      return {
        results: {
          observations: this.sortMetadataFallback(fallbackObservations, options.limit, options.orderBy),
          sessions: [],
          prompts: []
        },
        usedChroma: false,
        strategy: 'hybrid'
      };
    }

    return this.emptyResult('hybrid');
  }

  private async rankAndHydrateForFile(
    filePath: string,
    metadataIds: number[],
    fallbackObservations: ObservationSearchResult[],
    options: { limit: number; project?: string; platformSource?: string; orderBy?: StrategySearchOptions['orderBy'] },
    sessions: SessionSummarySearchResult[]
  ): Promise<{ observations: ObservationSearchResult[]; sessions: SessionSummarySearchResult[]; usedChroma: boolean }> {
    const chromaResults = await this.chromaSync.queryChroma(
      filePath,
      Math.min(metadataIds.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE),
      this.buildObservationWhereFilter(options.project, options.platformSource)
    );

    const rankedIds = this.intersectWithRanking(metadataIds, chromaResults.ids);

    if (rankedIds.length > 0) {
      const observations = this.sessionStore.getObservationsByIds(rankedIds, {
        orderBy: 'relevance',
        limit: options.limit,
        project: options.project,
        platformSource: options.platformSource
      });
      observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

      return { observations, sessions, usedChroma: true };
    }

    if (options.platformSource) {
      return {
        observations: this.sortMetadataFallback(fallbackObservations, options.limit, options.orderBy),
        sessions,
        usedChroma: false
      };
    }

    return { observations: [], sessions, usedChroma: false };
  }

  private sortMetadataFallback(
    observations: ObservationSearchResult[],
    limit: number,
    orderBy: StrategySearchOptions['orderBy'] = 'date_desc'
  ): ObservationSearchResult[] {
    const sorted = [...observations].sort((a, b) => {
      const epochDelta = a.created_at_epoch - b.created_at_epoch;
      if (epochDelta !== 0) {
        return orderBy === 'date_asc' ? epochDelta : -epochDelta;
      }
      const idDelta = a.id - b.id;
      return orderBy === 'date_asc' ? idDelta : -idDelta;
    });
    return sorted.slice(0, limit);
  }

  private buildObservationWhereFilter(project?: string, platformSource?: string): Record<string, any> {
    const filters: Array<Record<string, any>> = [{ doc_type: 'observation' }];
    if (project) {
      filters.push({ project });
    }
    if (platformSource) {
      filters.push({ platform_source: normalizePlatformSource(platformSource) });
    }
    return filters.length === 1 ? filters[0] : { $and: filters };
  }

  private intersectWithRanking(metadataIds: number[], chromaIds: number[]): number[] {
    const metadataSet = new Set(metadataIds);
    const rankedIds: number[] = [];

    for (const chromaId of chromaIds) {
      if (metadataSet.has(chromaId) && !rankedIds.includes(chromaId)) {
        rankedIds.push(chromaId);
      }
    }

    return rankedIds;
  }
}
