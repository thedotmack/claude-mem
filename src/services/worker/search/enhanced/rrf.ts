export interface RrfOptions {
  /** Rank-fusion constant. Higher k flattens the contribution of top ranks. */
  k?: number;
  /** Truncate the merged list to this length. */
  limit?: number;
}

/**
 * Reciprocal Rank Fusion: score(d) = sum_i 1 / (k + rank_i(d)).
 * Each input list is a ranked array of observation ids (best first).
 * Returns merged ids, best first. Ported from lib_baseline.rrf_merge.
 */
export function rrfMerge(rankedLists: number[][], options: RrfOptions = {}): number[] {
  const k = options.k ?? 60;
  const scores = new Map<number, number>();

  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }

  const merged = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return options.limit != null ? merged.slice(0, options.limit) : merged;
}
