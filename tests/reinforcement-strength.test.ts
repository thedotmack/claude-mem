// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import {
  ageDays,
  parseReinforcementDates,
  appendReinforcement,
  isoDay,
  MAX_REINFORCEMENT_HISTORY,
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
    expect(dates.length).toBe(MAX_REINFORCEMENT_HISTORY);
    expect(dates[dates.length - 1]).toBe(isoDay(TODAY)); // newest retained
  });
  it('stays idempotent on unsorted history (membership check, not tail check)', () => {
    // Unsorted input — as produced by a cross-device merge or manual edit.
    // The old tail-only check would append a duplicate for TODAY here.
    const unsorted = [isoDay(TODAY), '2020-01-01'];
    const once = appendReinforcement(unsorted, TODAY);
    expect(once).toBe(unsorted); // no-op, same reference
    expect(once.filter(d => d === isoDay(TODAY)).length).toBe(1);
  });
});
