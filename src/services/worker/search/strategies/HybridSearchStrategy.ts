/**
 * HybridSearchStrategy - Combines metadata filtering with semantic ranking
 *
 * This strategy provides the best of both worlds:
 * 1. SQLite metadata filter (get all IDs matching criteria)
 * 2. Chroma semantic ranking (rank by relevance)
 * 3. Intersection (keep only IDs from step 1, in rank order from step 2)
 * 4. Hydrate from SQLite in semantic rank order
 *
 * Used for: findByConcept, findByFile, findByType with Chroma available
 */

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
    // Can handle when we have metadata filters and Chroma is available
    return !!this.chromaSync && (
      !!options.concepts ||
      !!options.files ||
      (!!options.type && !!options.query) ||
      options.strategyHint === 'hybrid'
    );
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    // This is the generic hybrid search - specific operations use dedicated methods
    const { query, limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project } = options;

    if (!query) {
      return this.emptyResult('hybrid');
    }

    // For generic hybrid search, use the standard Chroma path
    // More specific operations (findByConcept, etc.) have dedicated methods
    return this.emptyResult('hybrid');
  }

  /**
   * Find observations by concept with semantic ranking
   * Pattern: Metadata filter -> Chroma ranking -> Intersection -> Hydrate
   */
  async findByConcept(
    concept: string,
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };

    logger.debug('SEARCH', 'HybridSearchStrategy: findByConcept', { concept });

    // Step 1: SQLite metadata filter
    const metadataResults = this.sessionSearch.findByConcept(concept, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    try {
      return await this.rankAndHydrate(concept, ids, limit);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'HybridSearchStrategy: findByConcept failed', {}, errorObj);
      // Fall back to metadata-only results
      const results = this.sessionSearch.findByConcept(concept, filterOptions);
      return {
        results: { observations: results, sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: true,
        strategy: 'hybrid'
      };
    }
  }

  /**
   * Find observations by type with semantic ranking
   */
  async findByType(
    type: string | string[],
    options: StrategySearchOptions
  ): Promise<StrategySearchResult> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy } = options;
    const filterOptions = { limit, project, dateRange, orderBy };
    const typeStr = Array.isArray(type) ? type.join(', ') : type;

    logger.debug('SEARCH', 'HybridSearchStrategy: findByType', { type: typeStr });

    // Step 1: SQLite metadata filter
    const metadataResults = this.sessionSearch.findByType(type as any, filterOptions);

    if (metadataResults.length === 0) {
      return this.emptyResult('hybrid');
    }

    const ids = metadataResults.map(obs => obs.id);

    try {
      return await this.rankAndHydrate(typeStr, ids, limit);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'HybridSearchStrategy: findByType failed', {}, errorObj);
      const results = this.sessionSearch.findByType(type as any, filterOptions);
      return {
        results: { observations: results, sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: true,
        strategy: 'hybrid'
      };
    }
  }

  /**
   * Find observations and sessions by file path with semantic ranking
   */
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

    // Step 1: SQLite metadata filter
    const metadataResults = this.sessionSearch.findByFile(filePath, filterOptions);
    const sessions = metadataResults.sessions;

    if (metadataResults.observations.length === 0) {
      return { observations: [], sessions, usedChroma: false };
    }

    const ids = metadataResults.observations.map(obs => obs.id);

    try {
      return await this.rankAndHydrateForFile(filePath, ids, limit, sessions);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'HybridSearchStrategy: findByFile failed', {}, errorObj);
      const results = this.sessionSearch.findByFile(filePath, filterOptions);
      return {
        observations: results.observations,
        sessions: results.sessions,
        usedChroma: false
      };
    }
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
        fellBack: false,
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

  /**
   * Intersect metadata IDs with Chroma IDs, preserving Chroma's rank order
   */
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
