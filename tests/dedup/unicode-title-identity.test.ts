import { describe, expect, it } from 'bun:test';
import { classifyPair } from '../../src/services/dedup/nearDuplicate.js';
import { normalizeTitle } from '../../src/services/dedup/normalize.js';

const thresholds = { cosineThreshold: 0.9, vetoThetaIdf: 1 };

describe('Unicode title identity', () => {
  it('does not silently merge distinct titles whose difference is a vowel mark', () => {
    expect(classifyPair('क', 'कि', () => 1, thresholds).tier).toBe('none');
    expect(normalizeTitle('कि')).toBe('कि');
  });
  it('recognizes canonically equivalent accented titles', () => {
    expect(classifyPair('Café fix', 'Cafe\u0301 fix', () => 1, thresholds).tier).toBe('exact');
  });
  it('still refuses exact identity for standalone combining marks', () => {
    expect(normalizeTitle('\u0301')).toBe('');
    expect(classifyPair('\u0301', '\u0301', () => 1, thresholds).tier).toBe('none');
  });
});
