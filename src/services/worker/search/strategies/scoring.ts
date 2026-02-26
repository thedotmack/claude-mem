/**
 * Scoring utilities for hybrid search blending.
 *
 * Pure functions with no external dependencies used to normalize and combine
 * scores from different search sources. Includes:
 * - normalizeMinMax / blendScores: positional-weighted blend (used in tests)
 * - rrfScore: Reciprocal Rank Fusion — parameter-free rank fusion (industry standard)
 * - topRankBonus: cross-ranker agreement bonus for top-K items
 */

/**
 * Normalize an array of raw scores to 0-1 range using min-max normalization.
 *
 * @param scores Raw scores array
 * @param invert If true, inverts the scale so that the minimum raw score maps
 *   to 1.0 and the maximum maps to 0.0. Use this for sources where lower raw
 *   values indicate better matches (e.g. Chroma distances, BM25 negative scores).
 * @returns Normalized scores in 0-1 range where 1.0 = best match
 */
export function normalizeMinMax(scores: number[], invert: boolean): number[] {
  if (scores.length === 0) {
    return [];
  }

  if (scores.length === 1) {
    return [1.0];
  }

  let min = scores[0];
  let max = scores[0];
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;

  if (range === 0) {
    return scores.map(() => 1.0);
  }

  return scores.map(score => {
    const normalized = (score - min) / range;
    return invert ? 1.0 - normalized : normalized;
  });
}

/**
 * Blend two score maps using weighted linear combination.
 *
 * IDs appearing in both maps get: vectorWeight * vectorScore + keywordWeight * keywordScore
 * IDs in only one map get: weight * score (partial score from that source only)
 *
 * @param vectorScores Map of id -> normalized 0-1 vector search score
 * @param keywordScores Map of id -> normalized 0-1 keyword search score
 * @param vectorWeight Weight for vector scores (default 0.6)
 * @param keywordWeight Weight for keyword scores (default 0.4)
 * @returns Map of id -> blended score
 */
export function blendScores(
  vectorScores: Map<number, number>,
  keywordScores: Map<number, number>,
  vectorWeight: number,
  keywordWeight: number
): Map<number, number> {
  const blended = new Map<number, number>();

  for (const [id, vectorScore] of vectorScores) {
    const keywordScore = keywordScores.get(id);
    if (keywordScore !== undefined) {
      blended.set(id, vectorWeight * vectorScore + keywordWeight * keywordScore);
    } else {
      blended.set(id, vectorWeight * vectorScore);
    }
  }

  for (const [id, keywordScore] of keywordScores) {
    if (!blended.has(id)) {
      blended.set(id, keywordWeight * keywordScore);
    }
  }

  return blended;
}

/**
 * Reciprocal Rank Fusion (RRF) — parameter-free rank fusion.
 *
 * For each ranker and each document d with 1-indexed rank r:
 *   contribution = 1 / (k + r)
 *
 * Scores are summed across all rankers, so documents appearing in multiple
 * rankers accumulate higher scores.
 *
 * @param rankers Array of rank maps (id → 1-indexed rank)
 * @param k Smoothing constant (default 60, standard RRF value)
 * @returns Map of id → RRF score
 */
export function rrfScore(
  rankers: ReadonlyArray<ReadonlyMap<number, number>>,
  k: number = 60
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const ranker of rankers) {
    for (const [id, rank] of ranker) {
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    }
  }

  return scores;
}

/**
 * Top-Rank Bonus — rewards cross-ranker agreement.
 *
 * Items that appear in the top-K of ALL rankers receive a flat bonus.
 * This incentivizes results that multiple search modalities agree are relevant.
 *
 * @param rankers Array of rank maps (id → 1-indexed rank)
 * @param topK Only items ranked ≤ topK in ALL rankers qualify (default 5)
 * @param bonus Flat bonus value for qualifying items (default 0.003)
 * @returns Map of id → bonus (only contains qualifying items)
 */
export function topRankBonus(
  rankers: ReadonlyArray<ReadonlyMap<number, number>>,
  topK: number = 5,
  bonus: number = 0.003
): Map<number, number> {
  if (rankers.length === 0) {
    return new Map();
  }

  // Collect all unique IDs across all rankers
  const allIds = new Set<number>();
  for (const ranker of rankers) {
    for (const id of ranker.keys()) {
      allIds.add(id);
    }
  }

  const result = new Map<number, number>();

  for (const id of allIds) {
    let inTopKOfAll = true;
    for (const ranker of rankers) {
      const rank = ranker.get(id);
      if (rank === undefined || rank > topK) {
        inTopKOfAll = false;
        break;
      }
    }
    if (inTopKOfAll) {
      result.set(id, bonus);
    }
  }

  return result;
}
