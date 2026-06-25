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

describe('golden corpus df preconditions (guards against miscalibration)', () => {
  it('rare identifiers appear exactly once (df=1 -> discriminating)', () => {
    for (const t of ['rdlp-api', 'rdlp-plugin', 'ffmpeg-7.1.conf', 'ffmpeg-6.1.conf']) {
      expect(df.get(t)).toBe(1);
    }
  });
  it('common-in-context discriminators are actually common (df>2 -> NOT vetoed)', () => {
    expect(df.get('code')!).toBeGreaterThan(golden.vetoDf);
    expect(df.get('security')!).toBeGreaterThan(golden.vetoDf);
  });
});

describe('classifyPair against the golden fixture', () => {
  for (const c of golden.cases) {
    it(`${c.tier.toUpperCase()}: ${c.note}`, () => {
      expect(classifyPair(c.a, c.b, idfFn, thresholds).tier).toBe(c.tier);
    });
  }

  it('NEVER auto-merges (Tier-0 exact) a common-token discriminator pair', () => {
    // The single most important data-loss guard: code/security must not be 'exact'.
    const r = classifyPair('Code review approval for xeve archive', 'Security review approval for xeve archive', idfFn, thresholds);
    expect(r.tier).not.toBe('exact');
  });
});

describe('classifyPair: empty/symbolic titles must NOT false-merge (data-loss guard)', () => {
  // normalizeTitle('') === normalizeTitle('🔵') === normalizeTitle('...') === '' —
  // distinct observations whose titles normalize to empty must NEVER be Tier-0 'exact'.
  // (This project uses emoji titles like 🔵/✅, so this is real, not theoretical.)
  const cases: [string | null | undefined, string | null | undefined][] = [
    ['...', '!!!'],
    [null, ''],
    ['🎉🎉', '***'],
    ['   ', undefined],
    ['🔵', '✅'],
  ];
  for (const [a, b] of cases) {
    it(`does not merge ${JSON.stringify(a)} with ${JSON.stringify(b)}`, () => {
      expect(classifyPair(a, b, idfFn, thresholds).tier).not.toBe('exact');
    });
  }

  it('still merges two genuinely-equal non-empty titles', () => {
    expect(classifyPair('On-Demand Checkpoint.', 'on demand checkpoint', idfFn, thresholds).tier).toBe('exact');
  });
});
