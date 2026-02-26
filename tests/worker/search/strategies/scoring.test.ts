import { describe, it, expect } from 'vitest';
import { normalizeMinMax, blendScores, rrfScore, topRankBonus } from '../../../../src/services/worker/search/strategies/scoring.js';

describe('normalizeMinMax', () => {
  describe('empty and edge cases', () => {
    it('returns empty array for empty input', () => {
      const result = normalizeMinMax([], false);
      expect(result).toEqual([]);
    });

    it('returns empty array for empty input with invert=true', () => {
      const result = normalizeMinMax([], true);
      expect(result).toEqual([]);
    });

    it('returns [1.0] for single element input', () => {
      const result = normalizeMinMax([42], false);
      expect(result).toEqual([1.0]);
    });

    it('returns [1.0] for single element input with invert=true', () => {
      const result = normalizeMinMax([42], true);
      expect(result).toEqual([1.0]);
    });

    it('returns all 1.0 when all scores are identical', () => {
      const result = normalizeMinMax([5, 5, 5, 5], false);
      expect(result).toEqual([1.0, 1.0, 1.0, 1.0]);
    });

    it('returns all 1.0 when all scores are identical with invert=true', () => {
      const result = normalizeMinMax([7, 7, 7], true);
      expect(result).toEqual([1.0, 1.0, 1.0]);
    });
  });

  describe('invert=false (natural order: higher raw = higher normalized)', () => {
    it('maps min to 0 and max to 1 for two elements', () => {
      const result = normalizeMinMax([0, 10], false);
      expect(result[0]).toBe(0);
      expect(result[1]).toBe(1);
    });

    it('correctly interpolates middle values', () => {
      const result = normalizeMinMax([0, 5, 10], false);
      expect(result[0]).toBeCloseTo(0, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(1.0, 5);
    });

    it('handles negative scores correctly', () => {
      const result = normalizeMinMax([-10, -5, 0], false);
      expect(result[0]).toBeCloseTo(0, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(1.0, 5);
    });

    it('handles mixed positive and negative scores', () => {
      const result = normalizeMinMax([-5, 0, 5], false);
      expect(result[0]).toBeCloseTo(0, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(1.0, 5);
    });

    it('preserves relative ordering for varied scores', () => {
      const result = normalizeMinMax([1, 4, 2, 8, 3], false);
      expect(result[0]).toBeCloseTo(0, 5);      // 1 is min
      expect(result[3]).toBeCloseTo(1.0, 5);    // 8 is max
      expect(result[1]).toBeGreaterThan(result[0]);
      expect(result[2]).toBeGreaterThan(result[0]);
      expect(result[4]).toBeGreaterThan(result[0]);
      expect(result[3]).toBeGreaterThan(result[1]);
    });

    it('all normalized scores are between 0 and 1', () => {
      const result = normalizeMinMax([3, 1, 4, 1, 5, 9, 2, 6], false);
      for (const score of result) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('invert=true (inverted scale: higher raw = lower normalized)', () => {
    it('maps max to 0 and min to 1 for two elements', () => {
      const result = normalizeMinMax([0, 10], true);
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(0);
    });

    it('correctly interpolates middle values with inversion', () => {
      const result = normalizeMinMax([0, 5, 10], true);
      expect(result[0]).toBeCloseTo(1.0, 5);
      expect(result[1]).toBeCloseTo(0.5, 5);
      expect(result[2]).toBeCloseTo(0.0, 5);
    });

    it('useful for BM25 where more negative scores = better match', () => {
      // BM25 typically returns negative scores; lower (more negative) = better
      // With invert=true: min raw → 1.0, max raw → 0.0
      const bm25Scores = [-10, -5, -1];
      const result = normalizeMinMax(bm25Scores, true);
      // range = -1 - (-10) = 9
      // -10 (min) → normalized 0 → inverted 1.0
      // -5  → normalized 5/9 → inverted 4/9 ≈ 0.4444
      // -1  (max) → normalized 1 → inverted 0.0
      expect(result[0]).toBeCloseTo(1.0, 5);           // -10 is min (best for BM25) → 1.0
      expect(result[1]).toBeCloseTo(4 / 9, 5);          // -5 → 4/9 ≈ 0.4444
      expect(result[2]).toBeCloseTo(0.0, 5);            // -1 is max (worst for BM25) → 0.0
    });

    it('useful for Chroma where lower distance = better match', () => {
      // Chroma returns distances; lower distance = more similar = better
      const distances = [0.1, 0.5, 0.9];
      const result = normalizeMinMax(distances, true);
      // 0.1 is the best (closest), 0.9 is worst
      // With invert=true: min (0.1) → 1.0, max (0.9) → 0.0
      expect(result[0]).toBeCloseTo(1.0, 5); // 0.1 is min → 1.0 (best)
      expect(result[1]).toBeCloseTo(0.5, 5); // 0.5 is middle → 0.5
      expect(result[2]).toBeCloseTo(0.0, 5); // 0.9 is max → 0.0 (worst)
    });

    it('all normalized scores are between 0 and 1 with inversion', () => {
      const result = normalizeMinMax([3, 1, 4, 1, 5, 9, 2, 6], true);
      for (const score of result) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('blendScores', () => {
  describe('empty inputs', () => {
    it('returns empty map when both maps are empty', () => {
      const result = blendScores(new Map(), new Map(), 0.6, 0.4);
      expect(result.size).toBe(0);
    });

    it('returns empty map when vector map is empty and keyword map is empty', () => {
      const result = blendScores(new Map<number, number>(), new Map<number, number>(), 0.7, 0.3);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('vector-only IDs (no overlap)', () => {
    it('scores vector-only IDs as vectorWeight * vectorScore', () => {
      const vectorScores = new Map([[1, 0.8], [2, 0.6]]);
      const keywordScores = new Map<number, number>();

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.get(1)).toBeCloseTo(0.6 * 0.8, 5);
      expect(result.get(2)).toBeCloseTo(0.6 * 0.6, 5);
    });

    it('includes all vector-only IDs in result', () => {
      const vectorScores = new Map([[10, 1.0], [20, 0.5], [30, 0.25]]);
      const keywordScores = new Map<number, number>();

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.has(10)).toBe(true);
      expect(result.has(20)).toBe(true);
      expect(result.has(30)).toBe(true);
    });
  });

  describe('keyword-only IDs (no overlap)', () => {
    it('scores keyword-only IDs as keywordWeight * keywordScore', () => {
      const vectorScores = new Map<number, number>();
      const keywordScores = new Map([[5, 0.9], [6, 0.3]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.get(5)).toBeCloseTo(0.4 * 0.9, 5);
      expect(result.get(6)).toBeCloseTo(0.4 * 0.3, 5);
    });

    it('includes all keyword-only IDs in result', () => {
      const vectorScores = new Map<number, number>();
      const keywordScores = new Map([[100, 1.0], [200, 0.7]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.has(100)).toBe(true);
      expect(result.has(200)).toBe(true);
    });
  });

  describe('overlapping IDs', () => {
    it('applies weighted sum: vectorWeight*vectorScore + keywordWeight*keywordScore', () => {
      const vectorScores = new Map([[1, 0.8]]);
      const keywordScores = new Map([[1, 0.6]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      const expected = 0.6 * 0.8 + 0.4 * 0.6;
      expect(result.get(1)).toBeCloseTo(expected, 5);
    });

    it('blends multiple overlapping IDs correctly', () => {
      const vectorScores = new Map([[1, 1.0], [2, 0.5]]);
      const keywordScores = new Map([[1, 0.5], [2, 1.0]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.get(1)).toBeCloseTo(0.6 * 1.0 + 0.4 * 0.5, 5); // 0.8
      expect(result.get(2)).toBeCloseTo(0.6 * 0.5 + 0.4 * 1.0, 5); // 0.7
    });

    it('handles all-overlapping case with standard weights', () => {
      const vectorScores = new Map([[1, 1.0], [2, 0.8], [3, 0.6]]);
      const keywordScores = new Map([[1, 0.7], [2, 0.9], [3, 0.5]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.size).toBe(3);
      expect(result.get(1)).toBeCloseTo(0.6 * 1.0 + 0.4 * 0.7, 5);
      expect(result.get(2)).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.9, 5);
      expect(result.get(3)).toBeCloseTo(0.6 * 0.6 + 0.4 * 0.5, 5);
    });
  });

  describe('mixed overlap and non-overlap', () => {
    it('handles mix of overlapping and non-overlapping IDs', () => {
      const vectorScores = new Map([[1, 0.9], [2, 0.7]]);
      const keywordScores = new Map([[2, 0.8], [3, 0.5]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      // ID 1: vector-only
      expect(result.get(1)).toBeCloseTo(0.6 * 0.9, 5);
      // ID 2: overlapping
      expect(result.get(2)).toBeCloseTo(0.6 * 0.7 + 0.4 * 0.8, 5);
      // ID 3: keyword-only
      expect(result.get(3)).toBeCloseTo(0.4 * 0.5, 5);
      // Total count
      expect(result.size).toBe(3);
    });

    it('result contains all unique IDs from both maps', () => {
      const vectorScores = new Map([[1, 0.5], [2, 0.5], [3, 0.5]]);
      const keywordScores = new Map([[3, 0.5], [4, 0.5], [5, 0.5]]);

      const result = blendScores(vectorScores, keywordScores, 0.6, 0.4);

      expect(result.size).toBe(5);
      expect(result.has(1)).toBe(true);
      expect(result.has(2)).toBe(true);
      expect(result.has(3)).toBe(true);
      expect(result.has(4)).toBe(true);
      expect(result.has(5)).toBe(true);
    });
  });

  describe('weight variations', () => {
    it('works with equal weights (0.5 / 0.5)', () => {
      const vectorScores = new Map([[1, 0.8]]);
      const keywordScores = new Map([[1, 0.6]]);

      const result = blendScores(vectorScores, keywordScores, 0.5, 0.5);

      expect(result.get(1)).toBeCloseTo(0.5 * 0.8 + 0.5 * 0.6, 5);
    });

    it('works with vector-only weighting (1.0 / 0.0)', () => {
      const vectorScores = new Map([[1, 0.75]]);
      const keywordScores = new Map([[1, 0.5]]);

      const result = blendScores(vectorScores, keywordScores, 1.0, 0.0);

      expect(result.get(1)).toBeCloseTo(1.0 * 0.75, 5);
    });

    it('works with keyword-only weighting (0.0 / 1.0)', () => {
      const vectorScores = new Map([[1, 0.75]]);
      const keywordScores = new Map([[1, 0.5]]);

      const result = blendScores(vectorScores, keywordScores, 0.0, 1.0);

      expect(result.get(1)).toBeCloseTo(1.0 * 0.5, 5);
    });
  });

  describe('return type', () => {
    it('returns a Map instance', () => {
      const result = blendScores(new Map([[1, 0.5]]), new Map([[2, 0.5]]), 0.6, 0.4);
      expect(result).toBeInstanceOf(Map);
    });

    it('returns number values in the map', () => {
      const result = blendScores(new Map([[1, 0.8]]), new Map([[1, 0.6]]), 0.6, 0.4);
      expect(typeof result.get(1)).toBe('number');
    });
  });
});

describe('rrfScore', () => {
  describe('single ranker', () => {
    it('returns 1/(k+rank) for each item with default k=60', () => {
      // Single ranker: A is rank 1, B is rank 2, C is rank 3
      const ranker = new Map<number, number>([[10, 1], [20, 2], [30, 3]]);
      const result = rrfScore([ranker]);

      expect(result.get(10)).toBeCloseTo(1 / (60 + 1), 10);
      expect(result.get(20)).toBeCloseTo(1 / (60 + 2), 10);
      expect(result.get(30)).toBeCloseTo(1 / (60 + 3), 10);
    });

    it('returns 1/(k+rank) with custom k parameter', () => {
      const ranker = new Map<number, number>([[10, 1], [20, 2]]);
      const result = rrfScore([ranker], 10);

      expect(result.get(10)).toBeCloseTo(1 / (10 + 1), 10);
      expect(result.get(20)).toBeCloseTo(1 / (10 + 2), 10);
    });
  });

  describe('two rankers with shared and disjoint IDs', () => {
    it('accumulates scores for items in both rankers', () => {
      // Ranker 1: A=rank1, B=rank2
      // Ranker 2: B=rank1, C=rank2
      const ranker1 = new Map<number, number>([[10, 1], [20, 2]]);
      const ranker2 = new Map<number, number>([[20, 1], [30, 2]]);
      const result = rrfScore([ranker1, ranker2]);

      // A: only in ranker1 → 1/(60+1)
      expect(result.get(10)).toBeCloseTo(1 / 61, 10);
      // B: in both → 1/(60+2) + 1/(60+1)
      expect(result.get(20)).toBeCloseTo(1 / 62 + 1 / 61, 10);
      // C: only in ranker2 → 1/(60+2)
      expect(result.get(30)).toBeCloseTo(1 / 62, 10);
    });

    it('shared items always score higher than single-ranker items', () => {
      const ranker1 = new Map<number, number>([[10, 1], [20, 2]]);
      const ranker2 = new Map<number, number>([[20, 1], [30, 2]]);
      const result = rrfScore([ranker1, ranker2]);

      // B (shared) should be higher than A or C (single-ranker)
      const scoreB = result.get(20) ?? 0;
      const scoreA = result.get(10) ?? 0;
      const scoreC = result.get(30) ?? 0;
      expect(scoreB).toBeGreaterThan(scoreA);
      expect(scoreB).toBeGreaterThan(scoreC);
    });
  });

  describe('k parameter effect', () => {
    it('smaller k amplifies rank differences', () => {
      const ranker = new Map<number, number>([[10, 1], [20, 5]]);

      const smallK = rrfScore([ranker], 1);
      const largeK = rrfScore([ranker], 100);

      // With k=1: score ratio = (1+5)/(1+1) = 3.0
      // With k=100: score ratio = (100+5)/(100+1) ≈ 1.04
      const smallKRatio = (smallK.get(10) ?? 0) / (smallK.get(20) ?? 1);
      const largeKRatio = (largeK.get(10) ?? 0) / (largeK.get(20) ?? 1);
      expect(smallKRatio).toBeGreaterThan(largeKRatio);
    });
  });

  describe('edge cases', () => {
    it('returns empty map for empty rankers array', () => {
      const result = rrfScore([]);
      expect(result.size).toBe(0);
    });

    it('returns empty map for single empty ranker', () => {
      const result = rrfScore([new Map()]);
      expect(result.size).toBe(0);
    });

    it('handles single-item rankers', () => {
      const ranker = new Map<number, number>([[42, 1]]);
      const result = rrfScore([ranker]);

      expect(result.size).toBe(1);
      expect(result.get(42)).toBeCloseTo(1 / 61, 10);
    });
  });
});

describe('topRankBonus', () => {
  describe('items in top-K of all rankers', () => {
    it('assigns bonus to items in top-5 of both rankers', () => {
      // Both rankers have item 10 in top 5
      const ranker1 = new Map<number, number>([[10, 1], [20, 2], [30, 6]]);
      const ranker2 = new Map<number, number>([[10, 3], [20, 7], [30, 2]]);

      const result = topRankBonus([ranker1, ranker2]);

      // Item 10: rank 1 in r1, rank 3 in r2 → both ≤ 5 → gets bonus
      expect(result.get(10)).toBe(0.003);
      // Item 20: rank 2 in r1, rank 7 in r2 → r2 > 5 → no bonus
      expect(result.has(20)).toBe(false);
      // Item 30: rank 6 in r1, rank 2 in r2 → r1 > 5 → no bonus
      expect(result.has(30)).toBe(false);
    });

    it('uses custom topK and bonus parameters', () => {
      const ranker1 = new Map<number, number>([[10, 1], [20, 3]]);
      const ranker2 = new Map<number, number>([[10, 2], [20, 2]]);

      const result = topRankBonus([ranker1, ranker2], 2, 0.01);

      // Item 10: rank 1, rank 2 → both ≤ 2 → gets bonus
      expect(result.get(10)).toBe(0.01);
      // Item 20: rank 3, rank 2 → r1 > 2 → no bonus
      expect(result.has(20)).toBe(false);
    });
  });

  describe('no items qualify', () => {
    it('returns empty map when no items are in top-K of all rankers', () => {
      const ranker1 = new Map<number, number>([[10, 1], [20, 6]]);
      const ranker2 = new Map<number, number>([[30, 1], [20, 6]]);

      const result = topRankBonus([ranker1, ranker2]);

      expect(result.size).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty map for empty rankers array', () => {
      const result = topRankBonus([]);
      expect(result.size).toBe(0);
    });

    it('returns empty map for single empty ranker', () => {
      const result = topRankBonus([new Map()]);
      expect(result.size).toBe(0);
    });

    it('with single ranker, all items in top-K get bonus', () => {
      const ranker = new Map<number, number>([[10, 1], [20, 3], [30, 6]]);
      const result = topRankBonus([ranker]);

      expect(result.get(10)).toBe(0.003);
      expect(result.get(20)).toBe(0.003);
      expect(result.has(30)).toBe(false); // rank 6 > 5
    });
  });
});
