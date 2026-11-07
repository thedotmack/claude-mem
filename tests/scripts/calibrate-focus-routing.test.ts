import { describe, expect, it } from 'bun:test';
import { scoreCutoff } from '../../scripts/calibrate-focus-routing.mjs';

// The labeled pairs labeledPairs gives for one request the router put in A and the owner moved to B.
const pairs = [{ anchor: 'r1', focusAreaId: 'fa_b', label: true, at: 2 }, { anchor: 'r1', focusAreaId: 'fa_a', label: false, at: 2 }];
const kept = new Set(['fa_a', 'fa_b', 'fa_c']);
const askable = (pair: { focusAreaId: string }) => pair.focusAreaId === 'other' || kept.has(pair.focusAreaId);
const score = (pick: { focusAreaId: string; confidence: number }, cutoff = 0.7, labeled = pairs, check = askable) =>
  scoreCutoff(labeled, new Map([['r1', pick]]), cutoff, check);

describe('calibrate-focus-routing scoring', () => {
  it('scores each accepted pick against the owner\'s target: any other area, not only the one moved out of, is a false positive', () => {
    expect(score({ focusAreaId: 'fa_b', confidence: 0.9 })).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(score({ focusAreaId: 'fa_a', confidence: 0.9 })).toEqual({ tp: 0, fp: 1, fn: 1 });
    // Jev picks C, an area the owner never named, above the cutoff: placing it there would be wrong.
    expect(score({ focusAreaId: 'fa_c', confidence: 0.9 })).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(score({ focusAreaId: 'other', confidence: 0.9 })).toEqual({ tp: 0, fp: 1, fn: 1 });
    // Below the cutoff nothing is placed: the target is missed, and nothing is placed wrongly.
    expect(score({ focusAreaId: 'fa_c', confidence: 0.5 })).toEqual({ tp: 0, fp: 0, fn: 1 });
  });

  it('the owner\'s latest placement is the target, and a target no longer kept scores only picks of an area the owner moved it out of', () => {
    const movedTwice = [...pairs, { anchor: 'r1', focusAreaId: 'fa_c', label: true, at: 3 }];
    expect(score({ focusAreaId: 'fa_c', confidence: 0.9 }, 0.7, movedTwice)).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(score({ focusAreaId: 'fa_b', confidence: 0.9 }, 0.7, movedTwice)).toEqual({ tp: 0, fp: 1, fn: 1 });
    const bGone = (pair: { focusAreaId: string }) => pair.focusAreaId !== 'fa_b' && askable(pair);
    expect(score({ focusAreaId: 'fa_a', confidence: 0.9 }, 0.7, pairs, bGone)).toEqual({ tp: 0, fp: 1, fn: 0 });
    expect(score({ focusAreaId: 'fa_c', confidence: 0.9 }, 0.7, pairs, bGone)).toEqual({ tp: 0, fp: 0, fn: 0 });
  });
});
