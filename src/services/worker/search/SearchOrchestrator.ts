
import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
import { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';

import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from './types.js';
import { ChromaUnavailableError } from './errors.js';
import { logger } from '../../../utils/logger.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';

interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
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
      try {
        const chromaResult = await this.chromaStrategy.search(options);
        if (options.platformSource && this.isEmptyResult(chromaResult)) {
          logger.debug('SEARCH', 'Orchestrator: platform-scoped Chroma search returned zero matches; falling back to SQLite', {});
          return await this.sqliteStrategy.search(options);
        }
        return chromaResult;
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ChromaUnavailableError(
          `Chroma query failed: ${errorObj.message}`,
          errorObj
        );
      }
    }

    logger.debug('SEARCH', 'Orchestrator: Chroma not configured', {});
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  private isEmptyResult(result: StrategySearchResult): boolean {
    return result.results.observations.length === 0
      && result.results.sessions.length === 0
      && result.results.prompts.length === 0;
  }

  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByConcept(concept, options);
    }

    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByType(type, options);
    }

    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
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
