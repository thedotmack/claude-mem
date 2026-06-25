import { describe, it, expect } from 'bun:test';
import { tfidfCosine } from '../../src/services/dedup/tfidfCosine.js';
import { buildIdfFn } from '../../src/services/dedup/idf.js';
import { tokenizeWs } from '../../src/services/dedup/normalize.js';

// Corpus model: shared words common (low idf), discriminating identifiers rare (high idf).
const DF = new Map<string, number>([
  ['added', 500], ['rdlp-redact', 50], ['dependency', 300], ['to', 900], ['crate', 200],
  ['rdlp-api', 3], ['rdlp-plugin', 3],
]);
const idfFn = buildIdfFn((t) => DF.get(t) ?? 0, 1000);
const tc = (a: string, b: string) => tfidfCosine(tokenizeWs(a), tokenizeWs(b), idfFn);

describe('tfidfCosine', () => {
  it('scores identical strings 1.0', () => {
    expect(tc('Added rdlp-redact to rdlp-api crate', 'Added rdlp-redact to rdlp-api crate')).toBeCloseTo(1, 5);
  });

  it('scores a pure word-reorder ~1.0 (same token set)', () => {
    expect(tc('rdlp-redact dependency added', 'added rdlp-redact dependency')).toBeCloseTo(1, 5);
  });

  it('scores LOW when the only difference is a rare discriminating token', () => {
    // "rdlp-api" vs "rdlp-plugin": high-idf tokens present on each side, absent from the
    // intersection → they inflate both norms but contribute nothing to the dot product.
    expect(tc('Added rdlp-redact dependency to rdlp-api crate',
              'Added rdlp-redact dependency to rdlp-plugin crate')).toBeLessThan(0.78);
  });

  it('scores 0 for disjoint token sets', () => {
    expect(tc('added rdlp-redact', 'dependency crate')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'Added rdlp-redact dependency to rdlp-api crate';
    const b = 'Added rdlp-redact dependency to rdlp-plugin crate';
    expect(tc(a, b)).toBeCloseTo(tc(b, a), 10);
  });

  it('returns 0 when either side is empty', () => {
    expect(tc('', 'added crate')).toBe(0);
    expect(tc('added crate', '')).toBe(0);
  });
});
