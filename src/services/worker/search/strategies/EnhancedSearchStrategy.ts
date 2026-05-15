import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { rrfMerge } from '../enhanced/rrf.js';
import { rerank } from '../enhanced/rerank.js';
import { shouldUseHybrid } from '../enhanced/routing.js';
import { logger } from '../../../../utils/logger.js';

// Top-N pulled from each backend before fusion — matches the prototype's Top-20.
const CANDIDATE_LIMIT = 20;

export class EnhancedSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'enhanced';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch,
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const { query, limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, obsType } = options;
    if (!query) {
      return this.emptyResult('enhanced');
    }

    // Stage 1 — FTS5 keyword search (cheap, local, always runs).
    const ftsResults = this.sessionSearch.searchObservations(query, {
      limit: CANDIDATE_LIMIT,
      project,
      dateRange,
      type: obsType as any,
      orderBy: 'relevance',
    });

    // Stage 2 — adaptive routing.
    const route = shouldUseHybrid(query, ftsResults);
    logger.debug('SEARCH', 'EnhancedSearchStrategy: routing decision', {
      reason: route.reason,
      useHybrid: route.useHybrid,
      topCoverage: route.topCoverage,
    });

    if (!route.useHybrid) {
      return {
        results: { observations: ftsResults.slice(0, limit), sessions: [], prompts: [] },
        usedChroma: false,
        strategy: 'enhanced',
      };
    }

    // Stage 3 — Chroma semantic search + RRF fusion.
    const whereFilter = project
      ? { $and: [{ doc_type: 'observation' }, { project }] }
      : { doc_type: 'observation' };

    let chromaIds: number[] = [];
    try {
      const chroma = await this.chromaSync.queryChroma(query, CANDIDATE_LIMIT, whereFilter);
      chromaIds = chroma.ids;
    } catch (error) {
      // Chroma down — degrade to FTS5-only rather than failing the request.
      logger.warn('SEARCH', 'EnhancedSearchStrategy: Chroma unavailable, FTS5-only fallback', {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        results: { observations: ftsResults.slice(0, limit), sessions: [], prompts: [] },
        usedChroma: false,
        strategy: 'enhanced',
      };
    }

    const ftsIds = ftsResults.map(o => o.id);
    const mergedIds = rrfMerge([ftsIds, chromaIds], { limit: CANDIDATE_LIMIT });

    if (mergedIds.length === 0) {
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: true,
        strategy: 'enhanced',
      };
    }

    // Stage 4 — hydrate + rerank. getObservationsByIds does not preserve the
    // requested order, so reorder to the RRF order before reranking.
    const hydrated = this.sessionStore.getObservationsByIds(mergedIds, {
      limit: CANDIDATE_LIMIT,
      project,
    });
    hydrated.sort((a, b) => mergedIds.indexOf(a.id) - mergedIds.indexOf(b.id));
    const reranked = rerank(hydrated, query);

    return {
      results: { observations: reranked.slice(0, limit), sessions: [], prompts: [] },
      usedChroma: true,
      strategy: 'enhanced',
    };
  }
}
