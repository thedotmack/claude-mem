/**
 * Scoring utilities for BM25/hybrid search blending.
 *
 * Pure functions with no external dependencies used to normalize and combine
 * scores from different search sources into a unified 0-1 range.
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
