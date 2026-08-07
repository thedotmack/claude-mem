// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import {
  ageDays,
  parseReinforcementDates,
  effectiveStrength,
  relevanceScore,
  appendReinforcement,
  isoDay,
  DEFAULT_TUNABLES,
} from '../src/services/reinforcement/strength.js';

// Fixed "today" so the calibration points are deterministic.
const TODAY = new Date('2026-06-17T12:00:00.000Z');
const iso = (daysAgo: number) =>
  new Date(TODAY.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe('ageDays', () => {
  it('clamps same-day and future dates to 1', () => {
    expect(ageDays(iso(0), TODAY)).toBe(1);
    expect(ageDays(iso(-5), TODAY)).toBe(1); // future
  });
  it('counts whole days back', () => {
    expect(ageDays(iso(30), TODAY)).toBe(30);
  });
  it('returns 1 for unparseable input', () => {
    expect(ageDays('not-a-date', TODAY)).toBe(1);
  });
});

describe('parseReinforcementDates', () => {
  it('returns [] for null/empty/garbage', () => {
    expect(parseReinforcementDates(null)).toEqual([]);
    expect(parseReinforcementDates('')).toEqual([]);
    expect(parseReinforcementDates('{not json')).toEqual([]);
    expect(parseReinforcementDates('42')).toEqual([]);
  });
  it('keeps only non-empty strings', () => {
    expect(parseReinforcementDates('["2026-06-17","",5,"2026-06-10"]')).toEqual([
      '2026-06-17',
      '2026-06-10',
    ]);
  });
});

describe('effectiveStrength — calibration points (d=0.5)', () => {
  const d = DEFAULT_TUNABLES.powerD;
  it('empty list → 0', () => {
    expect(effectiveStrength([], TODAY, d)).toBe(0);
  });
  it('single fresh event → ln(2)', () => {
    expect(effectiveStrength([iso(0)], TODAY, d)).toBeCloseTo(Math.log(2), 6); // ≈0.693
  });
  it('10 events clustered today → ln(11)', () => {
    const dates = Array.from({ length: 10 }, () => iso(0));
    expect(effectiveStrength(dates, TODAY, d)).toBeCloseTo(Math.log(11), 6); // ≈2.398
  });
  it('single stale event at 30 days → ln(1 + 30^-0.5)', () => {
    expect(effectiveStrength([iso(30)], TODAY, d)).toBeCloseTo(Math.log(1 + Math.pow(30, -0.5)), 6); // ≈0.167
  });
  it('fresh > spread > stale (monotonic intuition)', () => {
    const fresh = effectiveStrength([iso(0), iso(0), iso(0)], TODAY, d);
    const spread = effectiveStrength([iso(0), iso(30), iso(60)], TODAY, d);
    const stale = effectiveStrength([iso(60)], TODAY, d);
    expect(fresh).toBeGreaterThan(spread);
    expect(spread).toBeGreaterThan(stale);
  });
});

describe('relevanceScore', () => {
  it('with alpha=0 reduces to pure keyword*2 + bonus (+beta·retrieval)', () => {
    const score = relevanceScore(
      { keywordScore: 3, bonus: 1, strength: 5, retrievalCount: 0 },
      { ...DEFAULT_TUNABLES, alpha: 0, beta: 0 },
    );
    expect(score).toBe(3 * 2 + 1);
  });
  it('strength multiplies relevance, never resurrects a zero-keyword note', () => {
    const noMatch = relevanceScore({ keywordScore: 0, bonus: 0, strength: 9 });
    expect(noMatch).toBe(0); // strength can only re-order things that already match
  });
  it('a reinforced note outranks an equally-matched cold note', () => {
    const cold = relevanceScore({ keywordScore: 2, strength: 0 });
    const warm = relevanceScore({ keywordScore: 2, strength: effectiveStrength([iso(0)], TODAY) });
    expect(warm).toBeGreaterThan(cold);
  });
});

describe('appendReinforcement', () => {
  it('appends today and is idempotent within a day', () => {
    const once = appendReinforcement([], TODAY);
    expect(once).toEqual([isoDay(TODAY)]);
    expect(appendReinforcement(once, TODAY)).toEqual(once); // no-op
  });
  it('FIFO-trims to maxHistory', () => {
    let dates: string[] = [];
    for (let i = 12; i >= 0; i--) {
      const day = new Date(TODAY.getTime() - i * 86_400_000);
      dates = appendReinforcement(dates, day);
    }
    expect(dates.length).toBe(10);
    expect(dates[dates.length - 1]).toBe(isoDay(TODAY)); // newest retained
  });
});
