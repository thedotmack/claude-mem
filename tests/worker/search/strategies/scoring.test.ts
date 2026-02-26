import { describe, it, expect } from 'vitest';
import { normalizeMinMax, blendScores } from '../../../../src/services/worker/search/strategies/scoring.js';

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
