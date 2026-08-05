// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { parseKeepDropVerdicts } from '../scripts/memory-eval/lib/judge.js';

describe('parseKeepDropVerdicts', () => {
  it('parses a clean JSON verdict list', () => {
    expect(parseKeepDropVerdicts('{"verdicts": ["keep", "drop", "keep", "drop", "keep"]}', 5))
      .toEqual([true, false, true, false, true]);
  });

  it('tolerates prose around the JSON', () => {
    const answer = 'Here are my verdicts:\n{"verdicts": ["drop", "drop"]}\nHope that helps.';
    expect(parseKeepDropVerdicts(answer, 2)).toEqual([false, false]);
  });

  it('is case-insensitive on the key and values', () => {
    expect(parseKeepDropVerdicts('{"Verdicts": ["KEEP", "Drop"]}', 2)).toEqual([true, false]);
  });

  it('tolerates unquoted tokens inside the array', () => {
    expect(parseKeepDropVerdicts('{"verdicts": [keep, drop, keep]}', 3)).toEqual([true, false, true]);
  });

  it('handles an all-drop answer', () => {
    expect(parseKeepDropVerdicts('{"verdicts": ["drop", "drop", "drop", "drop", "drop"]}', 5))
      .toEqual([false, false, false, false, false]);
  });

  it('fails OPEN (keep all) when there is no JSON at all', () => {
    expect(parseKeepDropVerdicts('I cannot decide.', 5)).toEqual([true, true, true, true, true]);
  });

  it('fails OPEN on a wrong verdict count', () => {
    expect(parseKeepDropVerdicts('{"verdicts": ["keep", "drop"]}', 5)).toEqual([true, true, true, true, true]);
    expect(parseKeepDropVerdicts('{"verdicts": ["keep", "drop", "keep", "drop", "keep", "keep"]}', 5))
      .toEqual([true, true, true, true, true]);
  });

  it('fails OPEN on unknown tokens', () => {
    expect(parseKeepDropVerdicts('{"verdicts": ["keep", "maybe", "drop"]}', 3)).toEqual([true, true, true]);
  });

  it('returns an empty array for zero candidates', () => {
    expect(parseKeepDropVerdicts('anything', 0)).toEqual([]);
  });
});
