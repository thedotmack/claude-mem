// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import {
  rankByStrength,
  poolSize,
  blendedScore,
  recencyHeadSize,
  type Rankable,
} from '../src/services/reinforcement/rank.js';
import { isoDay } from '../src/services/reinforcement/strength.js';

const TODAY = new Date('2026-06-17T12:00:00Z');
const DAY = 86_400_000;
const epoch = (daysAgo: number) => TODAY.getTime() - daysAgo * DAY;
const dayStr = (daysAgo: number) => isoDay(new Date(epoch(daysAgo)));

type Row = Rankable & { id: number };

// A recency-ordered pool (newest first), as `ORDER BY created_at_epoch DESC` returns it.
// `reinforced` lists days-ago of the history; the first entry is the seeded creation day.
function pool(...specs: Array<{ age: number; reinforced?: number[] }>): Row[] {
  return specs
    .map((s, id) => ({
      id,
      created_at_epoch: epoch(s.age),
      reinforcement_dates: JSON.stringify((s.reinforced ?? [s.age]).map(dayStr)),
    }))
    .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
}
const ids = (rows: Row[]) => rows.map(r => r.id);
const HEAVY = (age: number) => ({ age, reinforced: [age, 30, 20, 10, 5, 3, 2, 1, 1, 1] });

describe('poolSize', () => {
  it('is exactly the count while ranking is off, so the query is unchanged', () => {
    expect(poolSize(20, 0)).toBe(20);
  });
  it('widens by the multiplier while ranking is on, capped', () => {
    expect(poolSize(20, 0.5)).toBe(100);
    expect(poolSize(200, 0.5)).toBe(500);
    expect(poolSize(0, 0.5)).toBe(0);
  });
  it('passes a show-all count through untouched', () => {
    expect(poolSize(999_999, 0.5)).toBe(999_999);
  });
});

describe('rankByStrength with alpha = 0 (the default)', () => {
  it('returns the pool itself when it fits the count', () => {
    const p = pool({ age: 1 }, { age: 5 });
    expect(rankByStrength(p, 5, 0, TODAY)).toBe(p);
  });

  it('keeps the N most recent in query order; reinforcement is ignored', () => {
    const p = pool({ age: 1 }, { age: 2 }, HEAVY(60));
    const out = rankByStrength(p, 2, 0, TODAY);
    expect(out.map(o => o.created_at_epoch)).toEqual([epoch(1), epoch(2)]);
  });
});

describe('rankByStrength with alpha > 0', () => {
  it('scores a heavily reinforced older observation above a fresher cold one', () => {
    const [fresh, reinforcedOld] = [pool({ age: 3 })[0], pool(HEAVY(40))[0]];
    expect(blendedScore(reinforcedOld, TODAY, 0.5)).toBeGreaterThan(blendedScore(fresh, TODAY, 0.5));
    expect(blendedScore(reinforcedOld, TODAY, 0)).toBeLessThan(blendedScore(fresh, TODAY, 0));
  });

  it('lets reinforced history take a non-head slot from a cold row', () => {
    // count 2 → head of 1 (the newest) + one ranked slot
    const p = pool({ age: 1 }, { age: 3 }, HEAVY(40));
    const out = rankByStrength(p, 2, 0.5, TODAY);
    expect(ids(out)).toEqual([0, 2]);
  });

  it('always keeps the newest rows, so a stale summary is never shown as current', () => {
    // Every older row is heavily reinforced; the recency head must still survive.
    const p = pool({ age: 1 }, { age: 2 }, HEAVY(10), HEAVY(20), HEAVY(30), HEAVY(40), HEAVY(50), HEAVY(60), HEAVY(70), HEAVY(80));
    const count = 8;
    const out = rankByStrength(p, count, 0.5, TODAY);
    expect(recencyHeadSize(count)).toBe(2);
    expect(ids(out).slice(0, 2)).toEqual([0, 1]);
    expect(out[0].created_at_epoch).toBe(epoch(1));
  });

  it('returns at most count rows, newest first', () => {
    const p = pool({ age: 2 }, HEAVY(50), { age: 8 }, { age: 9 }, { age: 12 });
    const out = rankByStrength(p, 3, 0.5, TODAY);
    expect(out.length).toBe(3);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].created_at_epoch).toBeGreaterThanOrEqual(out[i].created_at_epoch);
    }
  });

  it('treats a missing or corrupt history as no reinforcement', () => {
    const rows: Row[] = [
      { id: 0, created_at_epoch: epoch(1), reinforcement_dates: null },
      { id: 1, created_at_epoch: epoch(2), reinforcement_dates: '{not json' },
      { id: 2, created_at_epoch: epoch(3) },
    ];
    expect(ids(rankByStrength(rows, 2, 0.5, TODAY))).toEqual([0, 1]);
  });
});
