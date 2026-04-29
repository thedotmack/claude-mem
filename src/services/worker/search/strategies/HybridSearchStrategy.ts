
import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
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

export class HybridSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'hybrid';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!this.chromaSync && (
      !!options.concepts ||
      !!options.files ||
      (!!options.type && !!options.query) ||
      options.strategyHint === 'hybrid'
    );
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const { query, limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project } = options;

    if (!query) {
      return this.emptyResult('hybrid');
    }

    return this.emptyResult('hybrid');
  }

  async findByConcept(
    concept: string,
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };

    logger.debug('SEARCH', 'HybridSearchStrategy: findByConcept', { concept });

    const metadataResults = this.sessionSearch.findByConcept(concept, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    return await this.rankAndHydrate(concept, ids, limit);
  }

  async findByType(
    type: string | string[],
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };
    const typeStr = Array.isArray(type) ? type.join(', ') : type;

    logger.debug('SEARCH', 'HybridSearchStrategy: findByType', { type: typeStr });

    const metadataResults = this.sessionSearch.findByType(type as any, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    return await this.rankAndHydrate(typeStr, ids, limit);
  }

  async findByFile(
    filePath: string,
    options: StrategySearchOptions
  ): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
    usedChroma: boolean;
  }> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };

    logger.debug('SEARCH', 'HybridSearchStrategy: findByFile', { filePath });

    const metadataResults = this.sessionSearch.findByFile(filePath, filterOptions);
    const sessions = metadataResults.sessions;

    if (metadataResults.observations.length === 0) {
      return { observations: [], sessions, usedChroma: false };
    }

    const ids = metadataResults.observations.map(obs => obs.id);

    return await this.rankAndHydrateForFile(filePath, ids, limit, sessions);
  }

  private async rankAndHydrate(
    queryText: string,
    metadataIds: number[],
    limit: number
  ): Promise<StrategySearchResult> {
    const chromaResults = await this.chromaSync.queryChroma(
      queryText,
      Math.min(metadataIds.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
    );

    const rankedIds = this.intersectWithRanking(metadataIds, chromaResults.ids);

    if (rankedIds.length > 0) {
      const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
      observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

      return {
        results: { observations, sessions: [], prompts: [] },
        usedChroma: true,
        strategy: 'hybrid'
      };
    }

    return this.emptyResult('hybrid');
  }

  private async rankAndHydrateForFile(
    filePath: string,
    metadataIds: number[],
    limit: number,
    sessions: SessionSummarySearchResult[]
  ): Promise<{ observations: ObservationSearchResult[]; sessions: SessionSummarySearchResult[]; usedChroma: boolean }> {
    const chromaResults = await this.chromaSync.queryChroma(
      filePath,
      Math.min(metadataIds.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
    );

    const rankedIds = this.intersectWithRanking(metadataIds, chromaResults.ids);

    if (rankedIds.length > 0) {
      const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
      observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

      return { observations, sessions, usedChroma: true };
    }

    return { observations: [], sessions, usedChroma: false };
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
