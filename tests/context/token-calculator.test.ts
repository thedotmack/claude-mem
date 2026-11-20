import { describe, it, expect } from 'bun:test';
import { calculateObservationTokens, calculateTokenEconomics } from '../../src/services/context/TokenCalculator.js';
import type { ObservationTokenFields } from '../../src/services/context/TokenCalculator.js';

function observation(overrides: Partial<ObservationTokenFields> = {}): ObservationTokenFields {
  return { title: null, subtitle: null, narrative: null, facts: null, discovery_tokens: null, ...overrides };
}

describe('calculateObservationTokens', () => {
  it.each([
    ['no content', {}, 0],
    ['title', { title: 'A'.repeat(40) }, 10],
    ['subtitle', { subtitle: 'B'.repeat(20) }, 5],
    ['narrative', { narrative: 'C'.repeat(80) }, 20],
    ['facts JSON', { facts: '["fact one", "fact two", "fact three"]' }, 10],
    ['all fields', { title: 'A'.repeat(20), subtitle: 'B'.repeat(20), narrative: 'C'.repeat(40), facts: '["test"]' }, 22],
    ['large narrative', { narrative: 'X'.repeat(4000) }, 1000],
    ['fractional tokens round up', { title: 'ABCDEFGHI' }, 3],
  ] as [string, Partial<ObservationTokenFields>, number][])('%s', (_, fields, expected) => {
    expect(calculateObservationTokens(observation(fields))).toBe(expected);
  });
});

describe('calculateTokenEconomics', () => {
  it.each([
    ['empty', [], [0, 0, 0, 0, 0]],
    ['counts observations', [{}, {}, {}], [3, 0, 0, 0, 0]],
    ['sums read tokens', [{ title: 'A'.repeat(40) }, { title: 'B'.repeat(40) }], [2, 20, 0, -20, 0]],
    ['sums discovery tokens', [{ discovery_tokens: 100 }, { discovery_tokens: 200 }, { discovery_tokens: 300 }], [3, 0, 600, 600, 100]],
    ['null discovery tokens', [{ discovery_tokens: 100 }, { discovery_tokens: null }, { discovery_tokens: 50 }], [3, 0, 150, 150, 100]],
    ['savings', [{ title: 'A'.repeat(40), discovery_tokens: 500 }], [1, 10, 500, 490, 98]],
    ['savings percent', [{ title: 'A'.repeat(396), discovery_tokens: 1000 }], [1, 99, 1000, 901, 90]],
    ['zero discovery tokens', [{ discovery_tokens: 0 }, { discovery_tokens: null }], [2, 0, 0, 0, 0]],
    ['negative savings', [{ narrative: 'X'.repeat(400), discovery_tokens: 50 }], [1, 100, 50, -50, -100]],
    ['rounds savings percent', [{ title: 'A'.repeat(130), discovery_tokens: 100 }], [1, 33, 100, 67, 67]],
    ['aggregates multiple observations', [
      { title: 'A'.repeat(20), narrative: 'X'.repeat(60), discovery_tokens: 500 },
      { title: 'B'.repeat(40), subtitle: 'Y'.repeat(40), discovery_tokens: 300 },
      { narrative: 'Z'.repeat(100), facts: '["fact1", "fact2"]', discovery_tokens: 200 },
    ], [3, 70, 1000, 930, 93]],
  ] as [string, Partial<ObservationTokenFields>[], number[]][])('%s', (_, fields, expected) => {
    const [totalObservations, totalReadTokens, totalDiscoveryTokens, savings, savingsPercent] = expected;
    expect(calculateTokenEconomics(fields.map(observation))).toEqual({
      totalObservations, totalReadTokens, totalDiscoveryTokens, savings, savingsPercent,
    });
  });
});
