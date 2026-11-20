import { describe, expect, it } from 'bun:test';
import { classifyPair } from '../../src/services/dedup/nearDuplicate.js';
import { normalizeTitle } from '../../src/services/dedup/normalize.js';

const thresholds = { cosineThreshold: 0.9, vetoThetaIdf: 1 };

describe('Unicode title identity', () => {
  it('still refuses exact identity for standalone combining marks', () => {
    expect(normalizeTitle('\u0301')).toBe('');
    expect(classifyPair('\u0301', '\u0301', () => 1, thresholds).tier).toBe('none');
  });
});
