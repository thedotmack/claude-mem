/**
 * HybridBlendingStrategy - Parallel semantic + keyword search with score blending
 *
 * This strategy runs ChromaSearchStrategy and BM25SearchStrategy in parallel,
 * then normalizes and blends their scores using a weighted linear combination:
 *   blended = VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * keywordScore
 *
 * Positional scoring is used as a rank-based proxy for relevance:
 *   For N results: score_i = (N - i) / N  (first result = 1.0, last = 1/N)
 *
 * Degradation:
 * - Both fail → empty result, fellBack: true
 * - Chroma fails → BM25-only result, strategy: 'bm25', fellBack: true
 * - BM25 fails → Chroma-only result, strategy: 'chroma', fellBack: true
 * - Both succeed → blended result, strategy: 'hybrid-blend', fellBack: false
 */

import type { SearchStrategy } from './SearchStrategy.js';
import { BaseSearchStrategy } from './SearchStrategy.js';
import type { ChromaSearchStrategy } from './ChromaSearchStrategy.js';
import type { BM25SearchStrategy } from './BM25SearchStrategy.js';
import { blendScores } from './scoring.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import { logger } from '../../../../utils/logger.js';

const VECTOR_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

export class HybridBlendingStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'hybrid-blend';

  constructor(
    private chromaStrategy: ChromaSearchStrategy,
    private bm25Strategy: BM25SearchStrategy
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    if (!options.query) {
      return this.emptyResult('hybrid-blend');
    }

    const limit = options.limit ?? SEARCH_CONSTANTS.DEFAULT_LIMIT;

    // Run both strategies in parallel
    const [chromaSettled, bm25Settled] = await Promise.allSettled([
      this.chromaStrategy.search(options),
      this.bm25Strategy.search(options)
    ]);

    const chromaOk =
      chromaSettled.status === 'fulfilled' && chromaSettled.value.usedChroma;
    const bm25Ok = bm25Settled.status === 'fulfilled';

    // --- Degradation cases ---

    if (!chromaOk && !bm25Ok) {
      logger.warn('SEARCH', 'HybridBlendingStrategy: Both strategies failed');
      return { ...this.emptyResult('hybrid-blend'), fellBack: true };
    }

    if (!chromaOk && bm25Ok) {
      logger.warn('SEARCH', 'HybridBlendingStrategy: Chroma failed, using BM25 only');
      return { ...bm25Settled.value, strategy: 'bm25', fellBack: true };
    }

    if (chromaOk && !bm25Ok) {
      logger.warn('SEARCH', 'HybridBlendingStrategy: BM25 failed, using Chroma only');
      return { ...chromaSettled.value, strategy: 'chroma', fellBack: true };
    }

    // Both succeeded — blend scores
    const chromaResults = (chromaSettled as PromiseFulfilledResult<StrategySearchResult>).value.results;
    const bm25Results = (bm25Settled as PromiseFulfilledResult<StrategySearchResult>).value.results;

    const mergedObs = this.mergeAndBlend(chromaResults.observations, bm25Results.observations, limit);
    const mergedSessions = this.deduplicateById(chromaResults.sessions, bm25Results.sessions);
    const mergedPrompts = this.deduplicateById(chromaResults.prompts, bm25Results.prompts);

    logger.debug('SEARCH', 'HybridBlendingStrategy: Blended results', {
      observations: mergedObs.length,
      sessions: mergedSessions.length,
      prompts: mergedPrompts.length
    });

    return {
      results: { observations: mergedObs, sessions: mergedSessions, prompts: mergedPrompts },
      usedChroma: true,
      fellBack: false,
      strategy: 'hybrid-blend'
    };
  }

  /**
   * Merge observations from Chroma and BM25 using positional scoring and
   * weighted linear combination.
   *
   * Positional score for result at index i out of N results: (N - i) / N
   *   index 0 → 1.0, index N-1 → 1/N
   *
   * Blended score = VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * keywordScore
   * Observations in only one set receive a partial score (other weight = 0).
   */
  private mergeAndBlend(
    chromaObs: ObservationSearchResult[],
    bm25Obs: ObservationSearchResult[],
    limit: number
  ): ObservationSearchResult[] {
    // Build positional score maps
    const vectorScores = new Map<number, number>();
    chromaObs.forEach((obs, i) => {
      vectorScores.set(obs.id, (chromaObs.length - i) / chromaObs.length);
    });

    const keywordScores = new Map<number, number>();
    bm25Obs.forEach((obs, i) => {
      keywordScores.set(obs.id, (bm25Obs.length - i) / bm25Obs.length);
    });

    // Blend scores
    const blended = blendScores(vectorScores, keywordScores, VECTOR_WEIGHT, KEYWORD_WEIGHT);

    // Build merged result map (deduplicated by ID, preserving first occurrence)
    const obsMap = new Map<number, ObservationSearchResult>();
    for (const obs of [...chromaObs, ...bm25Obs]) {
      if (!obsMap.has(obs.id)) {
        obsMap.set(obs.id, { ...obs, score: blended.get(obs.id) });
      }
    }

    // Sort by blended score descending and apply limit
    return [...obsMap.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  /**
   * Deduplicate items from two arrays by ID, preserving insertion order
   * (items from the first array take precedence).
   */
  private deduplicateById<T extends { id: number }>(first: T[], second: T[]): T[] {
    const seen = new Set<number>();
    const result: T[] = [];

    for (const item of [...first, ...second]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }

    return result;
  }
}
