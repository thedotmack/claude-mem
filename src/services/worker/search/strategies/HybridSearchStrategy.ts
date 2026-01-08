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

    try {
      logger.debug('SEARCH', 'HybridSearchStrategy: findByConcept', { concept });

      // Step 1: SQLite metadata filter
      const metadataResults = this.sessionSearch.findByConcept(concept, filterOptions);
      logger.debug('SEARCH', 'HybridSearchStrategy: Found metadata matches', {
        count: metadataResults.length
      });

      if (metadataResults.length === 0) {
        return this.emptyResult('hybrid');
      }

      // Step 2: Chroma semantic ranking
      const ids = metadataResults.map(obs => obs.id);
      const chromaResults = await this.chromaSync.queryChroma(
        concept,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect - keep only IDs from metadata, in Chroma rank order
      const rankedIds = this.intersectWithRanking(ids, chromaResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked by semantic relevance', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in semantic rank order
      if (rankedIds.length > 0) {
        const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
        // Restore semantic ranking order
        observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return {
          results: { observations, sessions: [], prompts: [] },
          usedChroma: true,
          fellBack: false,
          strategy: 'hybrid'
        };
      }

      return this.emptyResult('hybrid');

    } catch (error) {
      logger.error('SEARCH', 'HybridSearchStrategy: findByConcept failed', {}, error as Error);
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

    try {
      logger.debug('SEARCH', 'HybridSearchStrategy: findByType', { type: typeStr });

      // Step 1: SQLite metadata filter
      const metadataResults = this.sessionSearch.findByType(type as any, filterOptions);
      logger.debug('SEARCH', 'HybridSearchStrategy: Found metadata matches', {
        count: metadataResults.length
      });

      if (metadataResults.length === 0) {
        return this.emptyResult('hybrid');
      }

      // Step 2: Chroma semantic ranking
      const ids = metadataResults.map(obs => obs.id);
      const chromaResults = await this.chromaSync.queryChroma(
        typeStr,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect with ranking
      const rankedIds = this.intersectWithRanking(ids, chromaResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked by semantic relevance', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in rank order
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

    } catch (error) {
      logger.error('SEARCH', 'HybridSearchStrategy: findByType failed', {}, error as Error);
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

    try {
      logger.debug('SEARCH', 'HybridSearchStrategy: findByFile', { filePath });

      // Step 1: SQLite metadata filter
      const metadataResults = this.sessionSearch.findByFile(filePath, filterOptions);
      logger.debug('SEARCH', 'HybridSearchStrategy: Found file matches', {
        observations: metadataResults.observations.length,
        sessions: metadataResults.sessions.length
      });

      // Sessions don't need semantic ranking (already summarized)
      const sessions = metadataResults.sessions;

      if (metadataResults.observations.length === 0) {
        return { observations: [], sessions, usedChroma: false };
      }

      // Step 2: Chroma semantic ranking for observations
      const ids = metadataResults.observations.map(obs => obs.id);
      const chromaResults = await this.chromaSync.queryChroma(
        filePath,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect with ranking
      const rankedIds = this.intersectWithRanking(ids, chromaResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked observations', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in rank order
      if (rankedIds.length > 0) {
        const observations = this.sessionStore.getObservationsByIds(rankedIds, { limit });
        observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return { observations, sessions, usedChroma: true };
      }

      return { observations: [], sessions, usedChroma: false };

    } catch (error) {
      logger.error('SEARCH', 'HybridSearchStrategy: findByFile failed', {}, error as Error);
      const results = this.sessionSearch.findByFile(filePath, filterOptions);
      return {
        observations: results.observations,
        sessions: results.sessions,
        usedChroma: false
      };
    }
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
