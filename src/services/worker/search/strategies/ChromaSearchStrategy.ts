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
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';

export class ChromaSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'chroma';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided and Chroma is available
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
      // Build Chroma where filter for doc_type and project
      const whereFilter = this.buildWhereFilter(searchType, project);

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
        // No matches - this is the correct answer
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedChroma: true,
          fellBack: false,
          strategy: 'chroma'
        };
      }

      // Step 2: Filter by recency (90 days)
      let recentItems = this.filterByRecency(chromaResults);
      logger.debug('SEARCH', 'ChromaSearchStrategy: Filtered by recency', {
        count: recentItems.length
      });

      // Step 2b: Optionally rerank with Flashrank cross-encoder
      let wasReranked = false;
      if (recentItems.length > 1 && query) {
        const rerankResult = await this.rerank(query, recentItems);
        recentItems = rerankResult.items;
        wasReranked = rerankResult.reranked;
      }

      // Step 3: Categorize by document type
      const categorized = this.categorizeByDocType(recentItems, {
        searchObservations,
        searchSessions,
        searchPrompts
      });

      // Step 4: Hydrate from SQLite with additional filters.
      // When reranked, omit limit from SQL so top-ranked items aren't dropped
      // by the date-based ORDER BY + LIMIT before we can restore reranked order.
      const hydrateLimit = wasReranked ? undefined : limit;

      if (categorized.obsIds.length > 0) {
        const obsOptions = { type: obsType, concepts, files, orderBy, limit: hydrateLimit, project };
        observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
      }

      if (categorized.sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
          orderBy,
          limit: hydrateLimit,
          project
        });
      }

      if (categorized.promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
          orderBy,
          limit: hydrateLimit,
          project
        });
      }

      // Step 4b: Restore reranked order after SQL hydration, then apply limit.
      // The hydration methods apply ORDER BY created_at_epoch, which discards
      // the reranked relevance order. Re-sort using the categorized ID arrays
      // (which preserve reranked order from categorizeByDocType), then trim.
      if (wasReranked) {
        observations = this.restoreIdOrder(observations, categorized.obsIds);
        sessions = this.restoreIdOrder(sessions, categorized.sessionIds);
        prompts = this.restoreIdOrder(prompts, categorized.promptIds);

        if (limit) {
          observations = observations.slice(0, limit);
          sessions = sessions.slice(0, limit);
          prompts = prompts.slice(0, limit);
        }
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

  /**
   * Optionally rerank Chroma results using the Flashrank microservice.
   *
   * When CLAUDE_MEM_RERANK_ENABLED=true, sends the top Chroma candidates to the
   * Flashrank cross-encoder service (POST /rerank) and re-orders them by score.
   * Falls back to the original Chroma ordering on any error.
   *
   * The Flashrank service must be running at CLAUDE_MEM_RERANK_URL. See
   * plugin/scripts/flashrank-service.py for the service implementation.
   */
  private async rerank(
    query: string,
    items: Array<{ id: number; meta: ChromaMetadata }>
  ): Promise<{ items: Array<{ id: number; meta: ChromaMetadata }>; reranked: boolean }> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (String(settings.CLAUDE_MEM_RERANK_ENABLED).toLowerCase() !== 'true') {
      return { items, reranked: false };
    }

    const rerankUrl = settings.CLAUDE_MEM_RERANK_URL || 'http://127.0.0.1:37778';

    try {
      // Build passage list from available Chroma metadata fields.
      // Chroma metadata does not store the full document text (that lives in SQLite),
      // but title, subtitle, concepts, and type provide enough signal for reranking.
      const passages = items.map(item => {
        const parts = [
          item.meta?.title,
          item.meta?.subtitle,
          item.meta?.concepts,
          item.meta?.type,
          item.meta?.doc_type
        ].filter(Boolean);
        return {
          id: String(item.id),
          text: parts.join(' ') || `${item.meta?.doc_type || 'doc'} ${item.id}`
        };
      });

      const response = await fetch(`${rerankUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, passages, top_k: passages.length }),
        signal: AbortSignal.timeout(5000)  // 5-second timeout
      });

      if (!response.ok) {
        logger.warn('SEARCH', 'Flashrank reranker returned non-OK status', {
          status: response.status
        });
        return { items, reranked: false };
      }

      const data = await response.json() as { results: Array<{ id: string; score: number }>; latency_ms: number };

      logger.debug('SEARCH', 'Flashrank reranker completed', {
        itemCount: items.length,
        latency_ms: data.latency_ms
      });

      // Build a score map and reorder items
      const scoreMap = new Map<number, number>();
      for (const result of data.results) {
        scoreMap.set(Number(result.id), result.score);
      }

      const rerankedItems = items
        .slice()
        .sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0));

      return { items: rerankedItems, reranked: true };

    } catch (error) {
      // Non-fatal: reranker is optional. Fall back to Chroma ordering.
      logger.debug('SEARCH', 'Flashrank reranker unavailable, using Chroma ordering', {
        error: (error as Error).message
      });
      return { items, reranked: false };
    }
  }

  /**
   * Build Chroma where filter for document type and project
   *
   * When a project is specified, includes it in the ChromaDB where clause
   * so that vector search is scoped to the target project. Without this,
   * larger projects dominate the top-N results and smaller projects get
   * crowded out before the post-hoc SQLite project filter can take effect.
   */
  private buildWhereFilter(searchType: string, project?: string): Record<string, any> | undefined {
    let docTypeFilter: Record<string, any> | undefined;
    switch (searchType) {
      case 'observations':
        docTypeFilter = { doc_type: 'observation' };
        break;
      case 'sessions':
        docTypeFilter = { doc_type: 'session_summary' };
        break;
      case 'prompts':
        docTypeFilter = { doc_type: 'user_prompt' };
        break;
      default:
        docTypeFilter = undefined;
    }

    if (project) {
      const projectFilter = { project };
      if (docTypeFilter) {
        return { $and: [docTypeFilter, projectFilter] };
      }
      return projectFilter;
    }

    return docTypeFilter;
  }

  /**
   * Filter results by recency (90-day window)
   *
   * IMPORTANT: ChromaSync.queryChroma() returns deduplicated `ids` (unique sqlite_ids)
   * but the `metadatas` array may contain multiple entries per sqlite_id (e.g., one
   * observation can have narrative + multiple facts as separate Chroma documents).
   *
   * This method iterates over the deduplicated `ids` and finds the first matching
   * metadata for each ID to avoid array misalignment issues.
   */
  private filterByRecency(chromaResults: {
    ids: number[];
    metadatas: ChromaMetadata[];
  }): Array<{ id: number; meta: ChromaMetadata }> {
    const cutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;

    // Build a map from sqlite_id to first metadata for efficient lookup
    const metadataByIdMap = new Map<number, ChromaMetadata>();
    for (const meta of chromaResults.metadatas) {
      if (meta?.sqlite_id !== undefined && !metadataByIdMap.has(meta.sqlite_id)) {
        metadataByIdMap.set(meta.sqlite_id, meta);
      }
    }

    // Iterate over deduplicated ids and get corresponding metadata
    return chromaResults.ids
      .map(id => ({
        id,
        meta: metadataByIdMap.get(id) as ChromaMetadata
      }))
      .filter(item => item.meta && item.meta.created_at_epoch > cutoff);
  }

  /**
   * Categorize IDs by document type
   */
  /**
   * Re-sort hydrated results to match the order of the given ID array.
   * Used after SQL hydration to restore reranked relevance order, since
   * the SQL queries apply ORDER BY created_at_epoch which discards it.
   */
  private restoreIdOrder<T extends { id: number }>(items: T[], orderedIds: number[]): T[] {
    if (orderedIds.length === 0) return items;
    const positionMap = new Map(orderedIds.map((id, index) => [id, index]));
    return [...items].sort((a, b) => {
      const posA = positionMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const posB = positionMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return posA - posB;
    });
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
