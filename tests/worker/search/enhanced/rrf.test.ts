import { test, expect, describe } from 'bun:test';
import { rrfMerge } from '../../../../src/services/worker/search/enhanced/rrf.js';

describe('rrfMerge', () => {
  test('id appearing high in both lists ranks first', () => {
    const fts = [10, 20, 30];
    const chroma = [10, 40, 50];
    const merged = rrfMerge([fts, chroma]);
    expect(merged[0]).toBe(10);
  });

  test('union of all ids is preserved', () => {
    const merged = rrfMerge([[1, 2], [3, 4]]);
    expect(merged.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test('limit truncates the result', () => {
    const merged = rrfMerge([[1, 2, 3, 4, 5]], { limit: 2 });
    expect(merged).toEqual([1, 2]);
  });

  test('empty input yields empty output', () => {
    expect(rrfMerge([])).toEqual([]);
    expect(rrfMerge([[], []])).toEqual([]);
  });

  test('single-list input preserves order', () => {
    expect(rrfMerge([[3, 1, 2]])).toEqual([3, 1, 2]);
  });
});
