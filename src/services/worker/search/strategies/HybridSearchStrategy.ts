/**
 * HybridSearchStrategy - Combines metadata filtering with semantic ranking
 *
 * This strategy provides the best of both worlds:
 * 1. SQLite metadata filter (get all IDs matching criteria)
 * 2. Vector semantic ranking (rank by relevance via SyncProvider)
 * 3. Intersection (keep only IDs from step 1, in rank order from step 2)
 * 4. Hydrate from appropriate source in semantic rank order:
 *    - Free users: SQLite (via ChromaSync delegation)
 *    - Pro users: Supabase (via CloudSync API)
 *
 * NOTE: For Pro users (cloud-primary), the SQLite metadata filtering step will
 * return empty results since data is stored in cloud. This strategy is primarily
 * useful for Free users. Pro users should use VectorSearchStrategy.
 *
 * Used for: findByConcept, findByFile, findByType with vector store available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult
} from '../types.js';
import { SyncProvider } from '../../../sync/SyncProvider.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';

export class HybridSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'hybrid';

  constructor(
    private syncProvider: SyncProvider,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when we have metadata filters and vector store is available
    return !!this.syncProvider && !this.syncProvider.isDisabled() && (
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

    // For generic hybrid search, use the standard vector path
    // More specific operations (findByConcept, etc.) have dedicated methods
    return this.emptyResult('hybrid');
  }

  /**
   * Find observations by concept with semantic ranking
   * Pattern: Metadata filter -> Vector ranking -> Intersection -> Hydrate
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

      // Step 2: Vector semantic ranking
      const ids = metadataResults.map(obs => obs.id);
      const vectorResults = await this.syncProvider.query(
        concept,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect - keep only IDs from metadata, in vector rank order
      const rankedIds = this.intersectWithRanking(ids, vectorResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked by semantic relevance', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in semantic rank order
      // Use syncProvider which delegates to appropriate source (SQLite or Supabase)
      if (rankedIds.length > 0) {
        const observations = await this.syncProvider.getObservationsByIds(rankedIds, { limit });
        // Restore semantic ranking order
        observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return {
          results: { observations, sessions: [], prompts: [] },
          usedVector: true,
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
        usedVector: false,
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

      // Step 2: Vector semantic ranking
      const ids = metadataResults.map(obs => obs.id);
      const vectorResults = await this.syncProvider.query(
        typeStr,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect with ranking
      const rankedIds = this.intersectWithRanking(ids, vectorResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked by semantic relevance', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in rank order
      // Use syncProvider which delegates to appropriate source (SQLite or Supabase)
      if (rankedIds.length > 0) {
        const observations = await this.syncProvider.getObservationsByIds(rankedIds, { limit });
        observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return {
          results: { observations, sessions: [], prompts: [] },
          usedVector: true,
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
        usedVector: false,
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
    usedVector: boolean;
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
        return { observations: [], sessions, usedVector: false };
      }

      // Step 2: Vector semantic ranking for observations
      const ids = metadataResults.observations.map(obs => obs.id);
      const vectorResults = await this.syncProvider.query(
        filePath,
        Math.min(ids.length, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE)
      );

      // Step 3: Intersect with ranking
      const rankedIds = this.intersectWithRanking(ids, vectorResults.ids);
      logger.debug('SEARCH', 'HybridSearchStrategy: Ranked observations', {
        count: rankedIds.length
      });

      // Step 4: Hydrate in rank order
      // Use syncProvider which delegates to appropriate source (SQLite or Supabase)
      if (rankedIds.length > 0) {
        const observations = await this.syncProvider.getObservationsByIds(rankedIds, { limit });
        observations.sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

        return { observations, sessions, usedVector: true };
      }

      return { observations: [], sessions, usedVector: false };

    } catch (error) {
      logger.error('SEARCH', 'HybridSearchStrategy: findByFile failed', {}, error as Error);
      const results = this.sessionSearch.findByFile(filePath, filterOptions);
      return {
        observations: results.observations,
        sessions: results.sessions,
        usedVector: false
      };
    }
  }

  /**
   * Intersect metadata IDs with vector IDs, preserving vector's rank order
   */
  private intersectWithRanking(metadataIds: number[], vectorIds: number[]): number[] {
    const metadataSet = new Set(metadataIds);
    const rankedIds: number[] = [];

    for (const vectorId of vectorIds) {
      if (metadataSet.has(vectorId) && !rankedIds.includes(vectorId)) {
        rankedIds.push(vectorId);
      }
    }

    return rankedIds;
  }

  /**
   * Helper to create empty result with correct strategy name
   */
  protected emptyResult(strategy: 'hybrid'): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedVector: false,
      fellBack: false,
      strategy
    };
  }
}
