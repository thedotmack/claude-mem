import { test, expect, describe } from 'bun:test';
import { significantTokens, jaccard } from '../../../../src/services/worker/search/enhanced/tokenize.js';

describe('significantTokens', () => {
  test('drops stopwords and short tokens, lowercases', () => {
    const t = significantTokens('The Worker restarted AND the DB was fine');
    expect(t.has('worker')).toBe(true);
    expect(t.has('restarted')).toBe(true);
    expect(t.has('the')).toBe(false);
    expect(t.has('and')).toBe(false);
    expect(t.has('db')).toBe(false); // length <= 2
  });

  test('empty / punctuation-only string yields empty set', () => {
    expect(significantTokens('   ... !!! ').size).toBe(0);
  });

  test('keeps non-ASCII tokens (German umlauts)', () => {
    const t = significantTokens('Worker löschen für Änderung');
    expect(t.has('löschen')).toBe(true);
    expect(t.has('änderung')).toBe(true);
    expect(t.has('für')).toBe(true);
  });
});

describe('jaccard', () => {
  test('identical sets => 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  test('disjoint sets => 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  test('half overlap', () => {
    // intersection 1, union 3
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3, 5);
  });
  test('empty operand => 0', () => {
    expect(jaccard(new Set<string>(), new Set(['a']))).toBe(0);
  });
});
