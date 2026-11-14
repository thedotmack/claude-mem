import { describe, expect, test } from 'bun:test';
import { MAX_SUBSTRING_TERMS, substringTerms } from '../../../src/services/sqlite/search-query.js';

describe('substring term selection', () => {
  test('retains the leading distinct terms while ignoring duplicates', () => {
    expect(substringTerms('first first second first third fourth', 3)).toEqual(['first', 'second', 'third']);
  });

  test('keeps mixed-script runs intact at the term boundary', () => {
    expect(substringTerms('alpha数据库beta𠮷野gamma 数据库', 4)).toEqual(['alpha', '数据库', 'beta', '𠮷野']);
  });

  test('applies the default cap and allows one extra term for overflow detection', () => {
    const terms = Array.from({ length: MAX_SUBSTRING_TERMS + 20 }, (_, index) => `term${index}`);
    const query = terms.join(' ');
    expect(substringTerms(query)).toEqual(terms.slice(0, MAX_SUBSTRING_TERMS));
    expect(substringTerms(query, MAX_SUBSTRING_TERMS + 1)).toEqual(terms.slice(0, MAX_SUBSTRING_TERMS + 1));
  });

  test('starts a fresh scan after an earlier scan stops at its cap', () => {
    expect(substringTerms('one two three', 1)).toEqual(['one']);
    expect(substringTerms('four five six', 2)).toEqual(['four', 'five']);
  });

  test('preserves empty queries and slice limit semantics', () => {
    expect(substringTerms(' \n\t ')).toEqual([]);
    for (const limit of [0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(substringTerms('one two three', limit)).toEqual(['one', 'two', 'three'].slice(0, limit));
    }
  });
});
