// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import {
  hitRateAtK, hitVector, meanTokens, meanRelevance, disagreementCount,
  saturationRate, parseGrid,
} from '../scripts/memory-eval/lib/metrics.js';
import { estimateTokens } from '../scripts/memory-eval/lib/common.js';
import { toFtsQuery } from '../scripts/memory-eval/lib/retrieve.js';

describe('hitRateAtK', () => {
  it('counts a query as hit when any gold id is in top-k', () => {
    const ranked = [[1, 2, 3, 4, 5], [10, 11, 12]];
    const gold = [[5], [99]];
    expect(hitRateAtK(ranked, gold, 5)).toBe(0.5);
  });

  it('respects k', () => {
    const ranked = [[1, 2, 3]];
    const gold = [[3]];
    expect(hitRateAtK(ranked, gold, 3)).toBe(1);
    expect(hitRateAtK(ranked, gold, 2)).toBe(0);
  });

  it('returns 0 for no queries', () => {
    expect(hitRateAtK([], [], 5)).toBe(0);
  });

  it('an empty ranked list is a miss', () => {
    expect(hitRateAtK([[]], [[1]], 5)).toBe(0);
  });
});

describe('hitVector / disagreementCount', () => {
  it('flags queries where lexical hit and judge disagree', () => {
    const ranked = [[1], [2], [3]];
    const gold = [[1], [9], [3]];
    const hits = hitVector(ranked, gold, 1); // [true, false, true]
    expect(hits).toEqual([true, false, true]);
    // judge: q1 says 0 relevant (disagree), q2 says 1 (disagree), q3 says 2 (agree)
    expect(disagreementCount(hits, [0, 1, 2])).toBe(2);
  });
});

describe('meanTokens / estimateTokens', () => {
  it('estimates chars/4, summed over title+narrative+facts', () => {
    expect(estimateTokens({ title: 'abcd', narrative: 'efgh', facts: null })).toBe(2);
    expect(estimateTokens({ title: null, narrative: 'abc', facts: null })).toBe(1); // ceil(3/4)
    expect(estimateTokens({})).toBe(0);
  });

  it('meanTokens averages per-query costs', () => {
    expect(meanTokens([10, 20, 30])).toBe(20);
    expect(meanTokens([])).toBe(0);
  });
});

describe('meanRelevance', () => {
  it('averages relevant/k per query, clamped to k', () => {
    expect(meanRelevance([5, 0, 3], 5)).toBeCloseTo((1 + 0 + 0.6) / 3);
    expect(meanRelevance([9], 5)).toBe(1); // clamped
    expect(meanRelevance([], 5)).toBe(0);
  });
});

describe('saturationRate', () => {
  it('measures gold already present in the recent block', () => {
    expect(saturationRate([[1, 2], [3, 4]], [[2], [9]])).toBe(0.5);
    expect(saturationRate([], [])).toBe(0);
  });
});

describe('parseGrid', () => {
  it('defaults to 0.2..1.0 step 0.1', () => {
    expect(parseGrid(undefined)).toEqual([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  });
  it('parses an explicit range and step', () => {
    expect(parseGrid('0.1..0.3', 0.1)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('toFtsQuery', () => {
  it('builds an OR query of significant quoted terms', () => {
    expect(toFtsQuery('Fix the login redirect bug please')).toBe('"fix" OR "login" OR "redirect" OR "bug"');
  });
  it('returns null when nothing usable remains', () => {
    expect(toFtsQuery('the and for')).toBeNull();
    expect(toFtsQuery('!! ??')).toBeNull();
  });
  it('caps the term count and dedupes', () => {
    const q = toFtsQuery(Array.from({ length: 30 }, (_, i) => `term${i} term${i}`).join(' '));
    expect(q?.split(' OR ').length).toBe(12);
  });
  it('splits on non-word characters (quotes never reach FTS)', () => {
    expect(toFtsQuery('weird"token')).toBe('"weird" OR "token"');
  });
});
