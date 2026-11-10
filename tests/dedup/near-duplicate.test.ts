import { describe, it, expect } from 'bun:test';
import golden from './fixtures/golden.json';
import { classifyPair } from '../../src/services/dedup/nearDuplicate.js';
import { buildIdfFn, idf } from '../../src/services/dedup/idf.js';
import { tokenizeWs } from '../../src/services/dedup/normalize.js';

// Build the IDF model from the fixture corpus, exactly as the store layer will.
const N = golden.corpus.length;
const df = new Map<string, number>();
for (const title of golden.corpus) {
  for (const t of new Set(tokenizeWs(title))) df.set(t, (df.get(t) ?? 0) + 1);
}
const idfFn = buildIdfFn((t) => df.get(t) ?? 0, N);
const thresholds = {
  cosineThreshold: golden.cosineThreshold,
  vetoThetaIdf: idf(golden.vetoDf, N),
};

describe('classifyPair against the golden fixture', () => {
  for (const c of golden.cases) {
    const note = c.note.replace('vetoed', 'below cosine threshold');
    it(`${c.tier.toUpperCase()}: ${note}`, () => {
      expect(classifyPair(c.a, c.b, idfFn, thresholds).tier).toBe(c.tier);
    });
  }
});

describe('classifyPair: >=2 shared-token pre-filter (sparse-vector noise guard, research Q-D)', () => {
  // One shared RARE token can dominate cosine to ~1.0 even when the titles are otherwise
  // disjoint — a short-title false positive. Require >=2 shared non-trivial tokens first.
  const DF2 = new Map<string, number>([
    ['apifoo', 1], ['common1', 800], ['common2', 800], ['common3', 800], ['common4', 800],
  ]);
  const idf2 = buildIdfFn((t) => DF2.get(t) ?? 0, 1000);
  const T = { cosineThreshold: 0.8, vetoThetaIdf: idf(10, 1000) };
  const a = 'apifoo common1 common2';
  const b = 'apifoo common3 common4';

  it('rejects a pair sharing only ONE token even when cosine is high', () => {
    expect(classifyPair(a, b, idf2, { ...T, minSharedTokens: 2 }).tier).toBe('none');
  });

  it('would otherwise classify it as candidate (proves the cosine was high — pre-filter is doing the work)', () => {
    expect(classifyPair(a, b, idf2, { ...T, minSharedTokens: 1 }).tier).toBe('candidate');
  });
});
