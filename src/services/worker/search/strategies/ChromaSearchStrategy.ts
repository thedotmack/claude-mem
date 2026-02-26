/**
 * ChromaSearchStrategy - Vector-based semantic search via Chroma
 *
 * This strategy handles semantic search queries using ChromaDB:
 * 1. Query Chroma for semantically similar documents
 * 2. Filter by recency (90-day window)
 * 3. Categorize by document type
 * 4. Hydrate from SQLite
 *
 * Used when: Query text is provided and Chroma is available
 */

import type { SearchStrategy } from './SearchStrategy.js';
import { BaseSearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ChromaMetadata,
  DateRange,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import {
  SEARCH_CONSTANTS
} from '../types.js';
import type { ChromaSync } from '../../../sync/ChromaSync.js';
import type { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';

export class ChromaSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'chroma';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query && !!this.chromaSync;
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
      return this.emptyResult('chroma');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    try {
      // Build Chroma where filter for doc_type
      const whereFilter = this.buildWhereFilter(searchType);

      // Step 1: Chroma semantic search
      logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });
      const chromaResults = await this.chromaSync.queryChroma(
        query,
        SEARCH_CONSTANTS.CHROMA_BATCH_SIZE,
        whereFilter
      );

      logger.debug('SEARCH', 'ChromaSearchStrategy: Chroma returned matches', {
        matchCount: chromaResults.ids.length
      });

      if (chromaResults.ids.length === 0) {
        // Zero matches is a valid result, not a failure — no fallback needed
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedChroma: true,
          fellBack: false,
          strategy: 'chroma'
        };
      }

      // Step 2: Filter by date range (user-specified) or recency (90-day default)
      const recentItems = this.filterByDateRange({
        ids: chromaResults.ids,
        metadatas: chromaResults.metadatas as unknown as ChromaMetadata[]
      }, options.dateRange);
      logger.debug('SEARCH', 'ChromaSearchStrategy: Filtered by date range', {
        count: recentItems.length
      });

      // Step 3: Categorize by document type
      const categorized = this.categorizeByDocType(recentItems, {
        searchObservations,
        searchSessions,
        searchPrompts
      });

      // Step 4: Hydrate from SQLite with additional filters
      // Chroma handles relevance sorting internally; for SQLite hydration, fall back to date_desc
      const sqlOrderBy = orderBy === 'relevance' ? 'date_desc' as const : orderBy;
      if (categorized.obsIds.length > 0) {
        const obsOptions = { type: obsType, concepts, files, orderBy: sqlOrderBy, limit, project };
        observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
      }

      if (categorized.sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
          orderBy: sqlOrderBy,
          limit,
          project
        });
      }

      if (categorized.promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
          orderBy: sqlOrderBy,
          limit,
          project
        });
      }

      logger.debug('SEARCH', 'ChromaSearchStrategy: Hydrated results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: true,
        fellBack: false,
        strategy: 'chroma'
      };

    } catch (error) {
      logger.error('SEARCH', 'ChromaSearchStrategy: Search failed', {}, error as Error);
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: false,
        strategy: 'chroma'
      };
    }
  }

  private buildWhereFilter(searchType: string): Record<string, unknown> | undefined {
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
   * Filter results by date range (user-specified) or recency (90-day default).
   *
   * If dateRange is provided, uses start/end as bounds.
   * Otherwise falls back to the 90-day recency window.
   */
  private filterByDateRange(
    chromaResults: { ids: number[]; metadatas: ChromaMetadata[] },
    dateRange?: DateRange
  ): Array<{ id: number; meta: ChromaMetadata }> {
    const rangeStart = dateRange?.start
      ? new Date(dateRange.start).getTime()
      : (Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS);
    const rangeEnd = dateRange?.end
      ? new Date(dateRange.end).getTime()
      : Infinity;

    return chromaResults.metadatas
      .map((meta, idx) => ({
        id: chromaResults.ids[idx],
        meta
      }))
      .filter(item =>
        item.meta.created_at_epoch >= rangeStart &&
        item.meta.created_at_epoch <= rangeEnd
      );
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
      const docType = item.meta.doc_type;
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
