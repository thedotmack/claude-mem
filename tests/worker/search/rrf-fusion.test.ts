import { describe, it, expect } from 'bun:test';
import { rrfFusion } from '../../../src/services/worker/search/rrf-fusion.js';
import type { RankedResult } from '../../../src/services/worker/search/rrf-fusion.js';

function mockRanked(id: number, score: number, source: RankedResult['source'] = 'fts5'): RankedResult {
  return { id, score, source };
}

describe('rrfFusion', () => {
  it('ranks items appearing in both lists higher', () => {
    const listA: RankedResult[] = [
      mockRanked(1, 0.9, 'fts5'),
      mockRanked(2, 0.8, 'fts5'),
    ];
    const listB: RankedResult[] = [
      mockRanked(2, 0.7, 'chroma'),
      mockRanked(3, 0.6, 'chroma'),
    ];
    const result = rrfFusion([listA, listB]);
    // id 2 appears in both lists, should rank first
    expect(result[0].id).toBe(2);
  });

  it('handles single list gracefully', () => {
    const listA: RankedResult[] = [mockRanked(1, 0.9)];
    const result = rrfFusion([listA]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('handles empty lists', () => {
    const result = rrfFusion([[], []]);
    expect(result).toHaveLength(0);
  });

  it('handles no lists', () => {
    const result = rrfFusion([]);
    expect(result).toHaveLength(0);
  });

  it('preserves all unique items from all lists', () => {
    const listA: RankedResult[] = [mockRanked(1, 0.9), mockRanked(2, 0.8)];
    const listB: RankedResult[] = [mockRanked(3, 0.7), mockRanked(4, 0.6)];
    const result = rrfFusion([listA, listB]);
    expect(result).toHaveLength(4);
  });

  it('uses custom K constant', () => {
    const listA: RankedResult[] = [mockRanked(1, 0.9)];
    const listB: RankedResult[] = [mockRanked(1, 0.7)];
    const resultDefault = rrfFusion([listA, listB]); // K=60
    const resultSmallK = rrfFusion([listA, listB], { k: 1 }); // K=1

    // With K=1, rank 0 gives 1/(1+0)=1.0 per list, total=2.0
    // With K=60, rank 0 gives 1/(60+0)=0.0167 per list, total=0.0333
    expect(resultSmallK[0].score).toBeGreaterThan(resultDefault[0].score);
  });

  it('correctly merges 3 lists', () => {
    const listA: RankedResult[] = [mockRanked(1, 0.9), mockRanked(2, 0.8)];
    const listB: RankedResult[] = [mockRanked(2, 0.7), mockRanked(3, 0.6)];
    const listC: RankedResult[] = [mockRanked(2, 0.5), mockRanked(4, 0.4)];
    const result = rrfFusion([listA, listB, listC]);
    // id 2 appears in all 3 lists
    expect(result[0].id).toBe(2);
  });

  it('simulates FTS5 + ChromaDB fusion', () => {
    // FTS5 finds exact keyword matches
    const fts5Results: RankedResult[] = [
      mockRanked(10, 0.95, 'fts5'),
      mockRanked(20, 0.80, 'fts5'),
      mockRanked(30, 0.70, 'fts5'),
    ];

    // ChromaDB finds semantic matches
    const chromaResults: RankedResult[] = [
      mockRanked(20, 0.90, 'chroma'),
      mockRanked(40, 0.85, 'chroma'),
      mockRanked(10, 0.75, 'chroma'),
    ];

    const fused = rrfFusion([fts5Results, chromaResults]);

    // id 10 and id 20 appear in both lists, should rank highest
    const topTwo = fused.slice(0, 2).map(r => r.id);
    expect(topTwo).toContain(10);
    expect(topTwo).toContain(20);

    // All 4 unique IDs preserved
    expect(fused).toHaveLength(4);
  });

  it('scores are purely rank-based, ignoring original magnitudes', () => {
    // Same ranks, wildly different original scores
    const listA: RankedResult[] = [
      mockRanked(1, 0.99, 'fts5'),
      mockRanked(2, 0.01, 'fts5'), // very low score but rank 1
    ];
    const listB: RankedResult[] = [
      mockRanked(3, 0.99, 'chroma'),
      mockRanked(2, 0.98, 'chroma'), // high score but rank 1
    ];
    const result = rrfFusion([listA, listB]);
    // id 2 appears at rank 1 in both lists -> RRF score = 2/(60+1)
    // id 1 appears at rank 0 in listA only -> RRF score = 1/(60+0)
    // id 3 appears at rank 0 in listB only -> RRF score = 1/(60+0)
    // id 2 should be first because it accumulates from both lists
    expect(result[0].id).toBe(2);
  });
});
