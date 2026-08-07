// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { rankByStrength, poolSize, blendedScore, type Rankable } from '../src/services/reinforcement/rank.js';
import { DEFAULT_TUNABLES, isoDay } from '../src/services/reinforcement/strength.js';

const TODAY = new Date('2026-06-17T12:00:00Z');
const DAY = 86_400_000;
const epoch = (daysAgo: number) => TODAY.getTime() - daysAgo * DAY;
const dayStr = (daysAgo: number) => isoDay(new Date(epoch(daysAgo)));

// A recency-ordered pool (newest first), as the SQL ORDER BY ... DESC returns.
function pool(...specs: Array<{ age: number; reinforced?: number[] }>): (Rankable & { id: number })[] {
  return specs
    .map((s, id) => ({
      id,
      created_at_epoch: epoch(s.age),
      reinforcement_dates: JSON.stringify((s.reinforced ?? [s.age]).map(dayStr)),
    }))
    .sort((a, b) => b.created_at_epoch - a.created_at_epoch);
}

// Strict legacy kill switch: both reinforcement (alpha) and surfacing (beta) off.
const OFF = { ...DEFAULT_TUNABLES, alpha: 0, beta: 0 };
const ON = { ...DEFAULT_TUNABLES, alpha: 0.5 };

describe('poolSize', () => {
  it('widens small counts by the multiplier, capped', () => {
    expect(poolSize(20)).toBe(100); // 20 * 5
    expect(poolSize(0)).toBe(0);
  });
  it('passes through counts at/above the cap (show-all sentinel)', () => {
    expect(poolSize(999999)).toBe(999999);
    expect(poolSize(500)).toBe(500);
  });
});

describe('rankByStrength — alpha=0 reproduces legacy recency selection', () => {
  it('returns the top-N most recent, in recency order', () => {
    const p = pool({ age: 1 }, { age: 5 }, { age: 10 }, { age: 30 });
    const out = rankByStrength(p, 2, TODAY, OFF);
    expect(out.map(o => (o as any).id)).toEqual(
      p.slice(0, 2).map(o => (o as any).id), // same two newest, same order
    );
    expect(out[0].created_at_epoch).toBeGreaterThan(out[1].created_at_epoch);
  });
  it('is identity when pool fits within count', () => {
    const p = pool({ age: 1 }, { age: 5 });
    expect(rankByStrength(p, 5, TODAY, OFF)).toBe(p);
  });

  it('ignores reinforcement entirely (kill switch): a reinforced old note stays buried', () => {
    const heavilyReinforcedOld = { age: 60, reinforced: [60, 30, 10, 5, 2, 1, 1, 1, 1, 1] };
    const p = pool({ age: 1 }, { age: 2 }, heavilyReinforcedOld);
    const out = rankByStrength(p, 2, TODAY, OFF);
    // Only the two freshest survive; the reinforced 60-day note is excluded.
    expect(out.map(o => o.created_at_epoch)).toEqual([epoch(1), epoch(2)]);
  });
});

describe('rankByStrength — alpha>0 lets reinforced history climb', () => {
  it('a heavily-reinforced older observation beats a fresher cold one', () => {
    // id 0: fresh (3 days), single seed.  id 1: older (40 days) but reinforced 10×.
    const fresh = { age: 3, reinforced: [3] };
    const reinforcedOld = { age: 40, reinforced: [40, 35, 30, 25, 20, 15, 10, 5, 2, 1] };
    const p = pool(fresh, reinforcedOld);
    const sFresh = blendedScore(p.find(o => (o as any).id === 0)!, TODAY, ON);
    const sOld = blendedScore(p.find(o => (o as any).id === 1)!, TODAY, ON);
    expect(sOld).toBeGreaterThan(sFresh);

    const out = rankByStrength(p, 1, TODAY, ON);
    expect((out[0] as any).id).toBe(1); // the reinforced old one wins the single slot
  });

  it('output is always re-sorted newest-first regardless of score', () => {
    const p = pool(
      { age: 2 },
      { age: 50, reinforced: [50, 40, 30, 20, 10, 5, 3, 2, 1, 1] },
      { age: 8 },
    );
    const out = rankByStrength(p, 3, TODAY, ON);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].created_at_epoch).toBeGreaterThanOrEqual(out[i].created_at_epoch);
    }
  });

  it('never returns more than count', () => {
    const p = pool({ age: 1 }, { age: 2 }, { age: 3 }, { age: 4 });
    expect(rankByStrength(p, 2, TODAY, ON).length).toBe(2);
  });
});
