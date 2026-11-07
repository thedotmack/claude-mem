
import {
  StrategySearchOptions,
  SearchSelection,
  SearchResults,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  isCategoryRequested,
  buildCategoryWhereFilter,
  ChromaMetadata,
  DateRange,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { ChromaSync, type ChromaQueryProgress } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { resolveDateBound } from '../../../../shared/date-bounds.js';
import { buildProjectWhereFilter, projectReadKeysFor } from '../project-where-filter.js';
import { scopeRowIdsFor } from '../scope-row-ids.js';

export class ChromaSearchStrategy {
  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    /**
     * Implicit window, in milliseconds, that date-less searches apply to
     * Chroma matches (CLAUDE_MEM_SEARCH_RECENCY_DAYS). 0 disables it; an
     * explicit `dateRange` on a request always wins over it.
     */
    private defaultRecencyWindowMs: number = SEARCH_CONSTANTS.RECENCY_WINDOW_MS
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
      offset = 0,
      project,
      projects,
      platformSource,
      dateRange,
      orderBy = 'date_desc',
      ignoreDefaultRecencyWindow = false
    } = options;

    if (!query) {
      return this.emptyResult('chroma');
    }

    const searchObservations = isCategoryRequested(searchType, 'observations');
    const searchSessions = isCategoryRequested(searchType, 'sessions');
    const searchPrompts = isCategoryRequested(searchType, 'prompts');

    // The keys SearchManager scopes a search by, so this path agrees with it:
    // the requested projects, their stored spellings, and one merge hop.
    const readKeys = projectReadKeysFor(this.sessionStore, project, projects);
    const whereFilter = this.buildWhereFilter(searchType, readKeys, platformSource);

    logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });

    return await this.executeChromaSearch(query, whereFilter, {
      searchObservations, searchSessions, searchPrompts,
      obsType, concepts, files, orderBy, limit, offset, project,
      projects: readKeys.length > 0 ? readKeys : undefined,
      platformSource, dateRange, ignoreDefaultRecencyWindow
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
      offset: number;
      project?: string;
      projects?: string[];
      platformSource?: string;
      dateRange?: DateRange;
      ignoreDefaultRecencyWindow: boolean;
    }
  ): Promise<StrategySearchResult> {
    const offset = Number(options.offset);
    const limit = Number(options.limit);
    const requiredResults = offset + limit;
    // Reuse native observation search's finite 100..1600 windows (#4510):
    // at most ten transport calls / 13100 requested raw fragments. Explicit
    // larger budgets (e.g. corpus builds) retain their existing single window.
    const maxCandidates = Math.max(1600, requiredResults);
    let candidateLimit: number = requiredResults > 1600 ? requiredResults : SEARCH_CONSTANTS.CHROMA_BATCH_SIZE;
    const observationCache = new Map<number, ObservationSearchResult | undefined>();
    const sessionCache = new Map<number, SessionSummarySearchResult | undefined>();
    const promptCache = new Map<number, UserPromptSearchResult | undefined>();
    let results: SearchResults = { observations: [], sessions: [], prompts: [] };
    let budgetReached = false;
    const sqlOptions = {
      orderBy: options.orderBy,
      project: options.project,
      projects: options.projects,
      platformSource: options.platformSource,
    };
    const fallbackRowIds = scopeRowIdsFor(this.sessionStore, {
      observations: options.searchObservations,
      sessions: options.searchSessions,
      prompts: options.searchPrompts,
    }, sqlOptions);

    while (true) {
      const progress: ChromaQueryProgress = {};
      const chromaResults = await this.chromaSync.queryChroma(query, candidateLimit, whereFilter, progress, fallbackRowIds);
      const recentItems = this.filterByRecency(chromaResults, options.dateRange, options.ignoreDefaultRecencyWindow);
      const categorized = this.categorizeByDocType(recentItems, options);
      results = {
        observations: this.hydrateCandidates(categorized.obsIds, observationCache, ids =>
          this.sessionStore.getObservationsByIds(ids, { ...sqlOptions, type: options.obsType, concepts: options.concepts, files: options.files }), options.orderBy),
        sessions: this.hydrateCandidates(categorized.sessionIds, sessionCache, ids =>
          this.sessionStore.getSessionSummariesByIds(ids, sqlOptions), options.orderBy),
        prompts: this.hydrateCandidates(categorized.promptIds, promptCache, ids =>
          this.sessionStore.getUserPromptsByIds(ids, sqlOptions), options.orderBy),
      };
      // Each requested category is paged independently. A full prompt page
      // cannot make a partial observation or summary page sufficient.
      const enoughResults = (!options.searchObservations || results.observations.length >= requiredResults)
        && (!options.searchSessions || results.sessions.length >= requiredResults)
        && (!options.searchPrompts || results.prompts.length >= requiredResults);
      if (enoughResults || progress.exhausted
        || (progress.exhausted === undefined && chromaResults.ids.length < candidateLimit)) break;
      if (candidateLimit >= maxCandidates) {
        budgetReached = true;
        break;
      }
      candidateLimit = Math.min(candidateLimit * 2, maxCandidates);
    }

    return {
      results: {
        observations: results.observations.slice(offset, offset + limit),
        sessions: results.sessions.slice(offset, offset + limit),
        prompts: results.prompts.slice(offset, offset + limit),
      },
      usedChroma: true,
      strategy: 'chroma',
      ...(budgetReached && { semanticBudgetReached: true }),
    };
  }

  private hydrateCandidates<T extends { id: number; created_at_epoch: number }>(
    ids: number[],
    cache: Map<number, T | undefined>,
    hydrate: (ids: number[]) => T[],
    orderBy: 'relevance' | 'date_desc' | 'date_asc'
  ): T[] {
    const unseen = ids.filter(id => !cache.has(id));
    for (let offset = 0; offset < unseen.length; offset += 500) {
      const batch = unseen.slice(offset, offset + 500);
      // Cache rejected IDs too. Repeated prefixes must not repeat native work.
      for (const id of batch) cache.set(id, undefined);
      for (const row of hydrate(batch)) cache.set(row.id, row);
    }
    const rows = ids.flatMap(id => {
      const row = cache.get(id);
      return row ? [row] : [];
    });
    if (orderBy !== 'relevance') rows.sort((a, b) => orderBy === 'date_asc'
      ? a.created_at_epoch - b.created_at_epoch || a.id - b.id
      : b.created_at_epoch - a.created_at_epoch || b.id - a.id);
    return rows;
  }

  private buildWhereFilter(searchType: SearchSelection, readKeys: string[], platformSource?: string): Record<string, any> | undefined {
    const filters: Array<Record<string, any>> = [];

    const categoryFilter = buildCategoryWhereFilter(searchType);
    if (categoryFilter) filters.push(categoryFilter);

    if (readKeys.length > 0) {
      filters.push(buildProjectWhereFilter(readKeys));
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
  }, dateRange: DateRange | undefined, ignoreDefaultRecencyWindow: boolean): Array<{ id: number; meta: ChromaMetadata }> {
    let startEpoch: number | undefined;
    let endEpoch: number | undefined;

    if (dateRange) {
      if (dateRange.start) {
        startEpoch = resolveDateBound(dateRange.start, 'start');
      }
      if (dateRange.end) {
        endEpoch = resolveDateBound(dateRange.end, 'end');
      }
    } else if (!ignoreDefaultRecencyWindow && this.defaultRecencyWindowMs > 0) {
      startEpoch = Date.now() - this.defaultRecencyWindowMs;
    }

    // ChromaSync deduplicates by (document type, SQLite id) and returns
    // aligned arrays. IDs are table-local: an observation and a prompt can
    // both be id 1, so keying metadata by the numeric id loses one category.
    return chromaResults.ids
      .map((id, index) => ({ id, meta: chromaResults.metadatas[index] }))
      .filter(item => item.meta && item.meta.created_at_epoch != null
        && (!startEpoch || item.meta.created_at_epoch >= startEpoch)
        && (!endEpoch || item.meta.created_at_epoch <= endEpoch));
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
