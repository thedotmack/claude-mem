import { describe, it, expect } from 'bun:test';
import { idf, buildIdfFn } from '../../src/services/dedup/idf.js';

describe('idf', () => {
  it('gives a rare token a higher score than a common token', () => {
    expect(idf(1, 1000)).toBeGreaterThan(idf(900, 1000));
  });

  it('is monotonically non-increasing in df', () => {
    expect(idf(1, 1000)).toBeGreaterThanOrEqual(idf(2, 1000));
    expect(idf(10, 1000)).toBeGreaterThanOrEqual(idf(100, 1000));
  });

  it('smooths df=0 without dividing by zero (highest score)', () => {
    const z = idf(0, 1000);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThan(idf(1, 1000));
  });

  it('a token present in every record has near-zero discriminating power', () => {
    // df == N: log(1 + N/(N+0.5)) ≈ log(2) — low, and below a typical veto threshold.
    expect(idf(1000, 1000)).toBeLessThan(idf(10, 1000));
  });
});

describe('buildIdfFn', () => {
  it('builds an idf function backed by a df lookup + corpus size', () => {
    const df = new Map<string, number>([['the', 900], ['rdlp-api', 2]]);
    const fn = buildIdfFn((t) => df.get(t) ?? 0, 1000);
    expect(fn('rdlp-api')).toBeGreaterThan(fn('the'));
    expect(fn('never-seen')).toBeGreaterThan(fn('rdlp-api')); // df=0 → highest
  });
});
