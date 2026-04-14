/**
 * Reciprocal Rank Fusion (RRF) for merging ranked search result lists
 *
 * Adapted from GBrain's hybrid.ts:68-87 (20 lines, core algorithm).
 * RRF score = sum(1 / (K + rank)) across all lists.
 * K=60 is the standard constant from the original RRF paper.
 *
 * Key insight: RRF only uses rank positions, not score magnitudes.
 * FTS5 returns ts_rank scores, ChromaDB returns cosine distances --
 * completely different scales. RRF makes fusion trivial.
 */

export interface RankedResult {
  /** Unique identifier (observation ID) */
  id: number;
  /** Original score from the search backend */
  score: number;
  /** Which search backend produced this result */
  source: 'fts5' | 'chroma' | 'entity';
}

export interface RRFOptions {
  /** K constant for RRF formula (default: 60, the academic standard) */
  k?: number;
}

/**
 * Merge multiple ranked result lists using Reciprocal Rank Fusion
 *
 * Items appearing in multiple lists accumulate higher RRF scores,
 * naturally ranking them above single-list items.
 */
export function rrfFusion(lists: RankedResult[][], opts: RRFOptions = {}): RankedResult[] {
  const k = opts.k ?? 60;
  const scores = new Map<number, { result: RankedResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const rrfScore = 1 / (k + rank);
      const existing = scores.get(r.id);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.id, { result: r, score: rrfScore });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}
