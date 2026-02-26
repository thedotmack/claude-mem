/**
 * HybridBlendingStrategy - Parallel semantic + keyword search with RRF score fusion
 *
 * This strategy runs ChromaSearchStrategy and BM25SearchStrategy in parallel,
 * then fuses their result rankings using Reciprocal Rank Fusion (RRF):
 *   score(d) = Σ 1/(k + rank_i(d))  for each ranker i
 *
 * A top-rank bonus rewards items that appear in the top-K of ALL rankers,
 * incentivizing cross-modality agreement.
 *
 * Degradation:
 * - Both fail → empty result, fellBack: true
 * - Chroma fails → BM25-only result, strategy: 'bm25', fellBack: true
 * - BM25 fails → Chroma-only result, strategy: 'chroma', fellBack: true
 * - Both succeed → RRF-fused result, strategy: 'hybrid-blend', fellBack: false
 */

import type { SearchStrategy } from './SearchStrategy.js';
import { BaseSearchStrategy } from './SearchStrategy.js';
import type { ChromaSearchStrategy } from './ChromaSearchStrategy.js';
import type { BM25SearchStrategy } from './BM25SearchStrategy.js';
import { rrfScore, topRankBonus } from './scoring.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import { logger } from '../../../../utils/logger.js';

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

    const mergedObs = this.mergeWithRRF(chromaResults.observations, bm25Results.observations, limit);
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
   * Merge observations from Chroma and BM25 using Reciprocal Rank Fusion (RRF).
   *
   * 1. Build 1-indexed rank maps from each result list's ordering
   * 2. Compute RRF scores: score(d) = Σ 1/(k + rank_i(d))
   * 3. Add top-rank bonus for items in top-5 of ALL rankers
   * 4. Sort by fused score descending and apply limit
   */
  private mergeWithRRF(
    chromaObs: ObservationSearchResult[],
    bm25Obs: ObservationSearchResult[],
    limit: number
  ): ObservationSearchResult[] {
    const vectorRanks = this.buildRankMap(chromaObs);
    const keywordRanks = this.buildRankMap(bm25Obs);
    const rankers = [vectorRanks, keywordRanks];

    const rrfScores = rrfScore(rankers);

    for (const [id, bonus] of topRankBonus(rankers)) {
      rrfScores.set(id, (rrfScores.get(id) ?? 0) + bonus);
    }

    // Deduplicate by ID, preserving first occurrence (Chroma results take precedence)
    const obsMap = new Map<number, ObservationSearchResult>();
    for (const obs of [...chromaObs, ...bm25Obs]) {
      if (!obsMap.has(obs.id)) {
        obsMap.set(obs.id, { ...obs, score: rrfScores.get(obs.id) });
      }
    }

    return [...obsMap.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  /** Build a 1-indexed rank map from an ordered result list. */
  private buildRankMap(results: ObservationSearchResult[]): Map<number, number> {
    const ranks = new Map<number, number>();
    for (let i = 0; i < results.length; i++) {
      ranks.set(results[i].id, i + 1);
    }
    return ranks;
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
