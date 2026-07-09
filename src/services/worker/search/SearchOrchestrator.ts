
import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import type { VectorSync } from '../../sync/VectorSync.js';

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
import { SEARCH_CONSTANTS, SEARCH_CATEGORIES, isCategoryRequested } from './types.js';
import { ChromaUnavailableError } from './errors.js';
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

export class SearchOrchestrator {
  private chromaStrategy: ChromaSearchStrategy | null = null;
  private sqliteStrategy: SQLiteSearchStrategy;
  private hybridStrategy: HybridSearchStrategy | null = null;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: VectorSync | null
  ) {
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }
  }

  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

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

    // The Chroma paths apply a default 90-day recency window when no dateRange
    // is given (filterByRecency); mirror it here so supplemented categories
    // share the same time semantics as the Chroma-backed ones.
    const supplementOptions: StrategySearchOptions = options.dateRange
      ? options
      : { ...options, dateRange: { start: Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS } };

    if (emptyCategories.length === requestedCategories.length) {
      logger.debug('SEARCH', 'Orchestrator: Chroma search returned zero matches for every requested category; falling back to SQLite', {});
      return await this.sqliteStrategy.search(supplementOptions);
    }

    logger.debug('SEARCH', 'Orchestrator: Chroma search returned zero matches for some categories; supplementing from SQLite', {
      categories: emptyCategories.join(',')
    });

    const mergedResults = { ...chromaResult.results };
    let supplemented = false;

    for (const category of emptyCategories) {
      const sqliteResult = await this.sqliteStrategy.search({ ...supplementOptions, searchType: category });
      if (sqliteResult.results[category].length > 0) {
        copyCategory(mergedResults, sqliteResult.results, category);
        supplemented = true;
      }
    }

    if (!supplemented) {
      return chromaResult;
    }

    return {
      results: mergedResults,
      usedChroma: true,
      strategy: 'hybrid'
    };
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

    const results = this.sqliteStrategy.findByFile(filePath, options);
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

    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

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
