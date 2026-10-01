
import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
import { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';

import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult,
  SearchResults,
  SearchCategory
} from './types.js';
import { SEARCH_CATEGORIES, isCategoryRequested } from './types.js';
import { ChromaUnavailableError } from './errors.js';
import { projectReadKeysFor } from './project-where-filter.js';
import { AppError } from '../../server/ErrorHandler.js';
import { logger } from '../../../utils/logger.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';

interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

function copyCategory<K extends SearchCategory>(
  target: SearchResults,
  source: SearchResults,
  category: K
): void {
  target[category] = source[category];
}

interface SearchRequestInput {
  query?: unknown;
  project?: unknown;
  platformSource?: unknown;
  dateRange?: { start?: unknown; end?: unknown } | null;
  obsType?: unknown;
  concepts?: unknown;
  files?: unknown;
}

function isPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

/**
 * Request-boundary check for search: a request needs query text or at least one row filter.
 * Each SessionSearch leg returns [] when none of the filters apply to it (so an obs_type-only
 * search is not rejected by the sessions and prompts legs), which means an empty request would
 * otherwise come back as a silent zero-result success instead of a 400.
 * A document category (`type: 'observations'`) selects what to search, not which rows, so it
 * does not count as a filter.
 */
export function assertSearchHasQueryOrFilter(input: SearchRequestInput): void {
  const hasDateRange = !!input.dateRange && (isPresent(input.dateRange.start) || isPresent(input.dateRange.end));
  const hasFilter = hasDateRange
    || [input.project, input.platformSource, input.obsType, input.concepts, input.files].some(isPresent);
  if (!isPresent(input.query) && !hasFilter) {
    throw new AppError('Either query or filters required for search', 400, 'INVALID_SEARCH_REQUEST');
  }
}

export class SearchOrchestrator {
  private chromaStrategy: ChromaSearchStrategy | null = null;
  private sqliteStrategy: SQLiteSearchStrategy;
  private hybridStrategy: HybridSearchStrategy | null = null;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null
  ) {
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }
  }

  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);
    assertSearchHasQueryOrFilter(options);

    return await this.executeWithFallback(options);
  }

  private async executeWithFallback(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    if (this.chromaStrategy) {
      logger.debug('SEARCH', 'Orchestrator: Using Chroma semantic search', {});
      let chromaResult: StrategySearchResult;
      try {
        chromaResult = await this.chromaStrategy.search(options);
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ChromaUnavailableError(
          `Chroma query failed: ${errorObj.message}`,
          errorObj
        );
      }
      return await this.supplementEmptyCategories(options, chromaResult);
    }

    logger.debug('SEARCH', 'Orchestrator: Chroma not configured', {});
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  /**
   * The one Chroma-empty fallback policy, shared by this pipeline and SearchManager.search().
   * Chroma answers with a single top-N query across every document type, so a requested
   * category can come back empty even though SQLite would find rows: for a CJK query the
   * prompts crowd out the observations, and a date window or an obs_type filter can drop
   * every hit. When every requested category is empty, fall back to SQLite entirely;
   * otherwise refill each empty category from SQLite and keep Chroma's results for the rest.
   * No recency window is applied on the SQLite side: an exact keyword hit older than 90 days
   * is the row this exists to surface, and the no-Chroma path applies none either.
   */
  async supplementEmptyCategories(
    options: StrategySearchOptions,
    chromaResult: StrategySearchResult
  ): Promise<StrategySearchResult> {
    const requestedCategories = SEARCH_CATEGORIES
      .filter(category => isCategoryRequested(options.searchType, category));
    const emptyCategories = requestedCategories
      .filter(category => chromaResult.results[category].length === 0);

    if (emptyCategories.length === 0) {
      return chromaResult;
    }

    if (emptyCategories.length === requestedCategories.length) {
      logger.debug('SEARCH', 'Orchestrator: Chroma returned zero matches for every requested category; falling back to SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    logger.debug('SEARCH', 'Orchestrator: Chroma returned zero matches for some categories; supplementing from SQLite', {
      categories: emptyCategories.join(',')
    });

    const mergedResults: SearchResults = { ...chromaResult.results };
    let supplemented = false;
    for (const category of emptyCategories) {
      const sqliteResult = await this.sqliteStrategy.search({ ...options, searchType: category });
      if (sqliteResult.results[category].length > 0) {
        copyCategory(mergedResults, sqliteResult.results, category);
        supplemented = true;
      }
    }

    return supplemented
      ? { results: mergedResults, usedChroma: true, strategy: 'hybrid' }
      : chromaResult;
  }

  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByFile(filePath, options);
    }

    // The keys the hybrid strategy scopes its file lookup by, so turning
    // Chroma off never changes which projects a file search reads.
    const readKeys = projectReadKeysFor(this.sessionStore, options.project, options.projects);
    const results = this.sqliteStrategy.findByFile(filePath, {
      ...options,
      projects: readKeys.length > 0 ? readKeys : undefined,
    });
    return { ...results, usedChroma: false };
  }

  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    const dateStart = normalized.dateStart ?? normalized.date_start ?? normalized.date_from;
    const dateEnd = normalized.dateEnd ?? normalized.date_end ?? normalized.date_to;
    if (dateStart || dateEnd) {
      normalized.dateRange = {
        start: dateStart,
        end: dateEnd
      };
    }
    delete normalized.dateStart;
    delete normalized.dateEnd;
    delete normalized.date_start;
    delete normalized.date_end;
    delete normalized.date_from;
    delete normalized.date_to;

    const rawPlatformSource = normalized.platformSource ?? normalized.platform_source;
    if (typeof rawPlatformSource === 'string' && rawPlatformSource.trim()) {
      normalized.platformSource = normalizePlatformSource(rawPlatformSource);
    } else {
      delete normalized.platformSource;
    }
    delete normalized.platform_source;

    return normalized;
  }
}
