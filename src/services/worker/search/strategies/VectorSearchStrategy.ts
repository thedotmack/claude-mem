/**
 * VectorSearchStrategy - Vector-based semantic search via SyncProvider
 *
 * This strategy handles semantic search queries using the active vector store
 * (ChromaSync for free users, CloudSync/Pinecone for Pro users):
 * 1. Query vector store for semantically similar documents
 * 2. Filter by recency (90-day window)
 * 3. Categorize by document type
 * 4. Hydrate from appropriate source:
 *    - Free users: SQLite (via ChromaSync delegation)
 *    - Pro users: Supabase (via CloudSync API)
 *
 * Used when: Query text is provided and vector store is available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ChromaMetadata,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SyncProvider } from '../../../sync/SyncProvider.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';

export class VectorSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'vector';

  constructor(
    private syncProvider: SyncProvider,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided and vector store is available
    return !!options.query && !!this.syncProvider && !this.syncProvider.isDisabled();
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
      orderBy = 'date_desc'
    } = options;

    if (!query) {
      return this.emptyResult('vector');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    try {
      // Build where filter for doc_type
      const whereFilter = this.buildWhereFilter(searchType);

      // Step 1: Vector semantic search
      logger.debug('SEARCH', 'VectorSearchStrategy: Querying vector store', { query, searchType, project });
      const vectorResults = await this.syncProvider.query(
        query,
        SEARCH_CONSTANTS.CHROMA_BATCH_SIZE,
        whereFilter,
        project
      );

      logger.debug('SEARCH', 'VectorSearchStrategy: Vector store returned matches', {
        matchCount: vectorResults.ids.length
      });

      if (vectorResults.ids.length === 0) {
        // No matches - this is the correct answer
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedVector: true,
          fellBack: false,
          strategy: 'vector'
        };
      }

      // Step 2: Filter by recency (90 days)
      const recentItems = this.filterByRecency(vectorResults);
      logger.debug('SEARCH', 'VectorSearchStrategy: Filtered by recency', {
        count: recentItems.length
      });

      // Step 3: Categorize by document type
      const categorized = this.categorizeByDocType(recentItems, {
        searchObservations,
        searchSessions,
        searchPrompts
      });

      // Step 4: Hydrate from appropriate source
      // - Pro users (cloud-primary): Fetch from Supabase via CloudSync
      // - Free users: Fetch from SQLite via ChromaSync delegation
      const hydrationSource = this.syncProvider.isCloudPrimary() ? 'cloud' : 'sqlite';
      logger.debug('SEARCH', `VectorSearchStrategy: Hydrating from ${hydrationSource}`, {
        obsIds: categorized.obsIds.length,
        sessionIds: categorized.sessionIds.length,
        promptIds: categorized.promptIds.length
      });

      if (categorized.obsIds.length > 0) {
        const obsOptions = { type: obsType, concepts, files, orderBy, limit, project };
        observations = await this.syncProvider.getObservationsByIds(categorized.obsIds, obsOptions);
      }

      if (categorized.sessionIds.length > 0) {
        sessions = await this.syncProvider.getSessionSummariesByIds(categorized.sessionIds, {
          orderBy,
          limit,
          project
        });
      }

      if (categorized.promptIds.length > 0) {
        prompts = await this.syncProvider.getUserPromptsByIds(categorized.promptIds, {
          orderBy,
          limit,
          project
        });
      }

      logger.debug('SEARCH', 'VectorSearchStrategy: Hydrated results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length,
        source: hydrationSource
      });

      return {
        results: { observations, sessions, prompts },
        usedVector: true,
        fellBack: false,
        strategy: 'vector'
      };

    } catch (error) {
      logger.error('SEARCH', 'VectorSearchStrategy: Search failed', {}, error as Error);
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedVector: false,
        fellBack: false,
        strategy: 'vector'
      };
    }
  }

  /**
   * Build where filter for document type
   */
  private buildWhereFilter(searchType: string): Record<string, any> | undefined {
    switch (searchType) {
      case 'observations':
        return { doc_type: 'observation' };
      case 'sessions':
        return { doc_type: 'session_summary' };
      case 'prompts':
        return { doc_type: 'user_prompt' };
      default:
        return undefined;
    }
  }

  /**
   * Filter results by recency (90-day window)
   */
  private filterByRecency(vectorResults: {
    ids: number[];
    metadatas: ChromaMetadata[];
  }): Array<{ id: number; meta: ChromaMetadata }> {
    const cutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;

    return vectorResults.metadatas
      .map((meta, idx) => ({
        id: vectorResults.ids[idx],
        meta
      }))
      .filter(item => item.meta && item.meta.created_at_epoch > cutoff);
  }

  /**
   * Categorize IDs by document type
   */
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

  /**
   * Helper to create empty result with correct strategy name
   */
  protected emptyResult(strategy: 'vector'): StrategySearchResult {
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedVector: false,
      fellBack: false,
      strategy
    };
  }
}
