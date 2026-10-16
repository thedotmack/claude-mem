import { describe, it, expect } from 'bun:test';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// buildFTSAnyTermQuery is the any-term widening fallback (#4130). Left unbounded it ORs every whitespace token of
// the prompt, so a long natural-language prompt forces FTS5 to score a huge fraction of the index (#4804). These
// tests pin the bound and dedup, not the exact ordering beyond "the rare/long content words survive the cap".
describe('buildFTSAnyTermQuery is bounded so a long prompt cannot score the whole index (#4804)', () => {
  const build = (query: string): string | null =>
    (SessionSearch as any).buildFTSAnyTermQuery(query) as string | null;

  // Each OR'd group is a single quoted phrase ("word"); count them to assert the cap on the widened set.
  const quotedGroupCount = (ftsQuery: string): number => (ftsQuery.match(/"(?:[^"]|"")*"/g) ?? []).length;

  it('caps the OR-ed set at 40 terms for a prompt with more than 40 distinct words', () => {
    const words = Array.from({ length: 120 }, (_, i) => `distinctword${i}`);
    const result = build(words.join(' '));
    expect(result).not.toBeNull();
    const groups = quotedGroupCount(result!);
    expect(groups).toBeLessThanOrEqual(40);
    expect(groups).toBe(40);
    // 40 groups means 39 separators.
    expect((result!.match(/ OR /g) ?? []).length).toBe(groups - 1);
  });

  it('collapses a common word repeated many times and keeps the rare long content words', () => {
    const prompt = `${'the '.repeat(50)}${'with '.repeat(50)}supercalibrationmatrix retryattemptceiling`.trim();
    const result = build(prompt);
    expect(result).not.toBeNull();
    // Only four distinct tokens survive dedup, so no cap is hit.
    expect(quotedGroupCount(result!)).toBe(4);
    // Each distinct token appears once (duplicates collapsed).
    expect((result!.match(/"the"/g) ?? []).length).toBe(1);
    expect((result!.match(/"with"/g) ?? []).length).toBe(1);
    // The rare (long) content words survive.
    expect(result).toContain('"supercalibrationmatrix"');
    expect(result).toContain('"retryattemptceiling"');
  });

  it('drops the common short stopwords first when a long prompt is capped', () => {
    const rare = Array.from({ length: 40 }, (_, i) => `longcontentword${i}`);
    const stopwords = Array.from({ length: 40 }, () => 'to'); // all dedupe to one short token
    const result = build([...stopwords, ...rare].join(' '));
    expect(result).not.toBeNull();
    expect(quotedGroupCount(result!)).toBe(40);
    // All 40 long content words outrank the lone short 'to', so each survives and 'to' is dropped.
    for (const word of rare) {
      expect(result).toContain(`"${word}"`);
    }
    expect(result).not.toContain('"to"');
  });

  it('returns null for a one- or two-token query (widening gate unchanged, #4130)', () => {
    expect(build('authentication')).toBeNull();
    expect(build('authentication bug')).toBeNull();
  });

  it('builds a valid OR string for a normal 3+ distinct-token short prompt', () => {
    const result = build('payment retry limit');
    expect(result).not.toBeNull();
    expect(result).toContain('"payment"');
    expect(result).toContain('"retry"');
    expect(result).toContain('"limit"');
    expect(result).toContain(' OR ');
    expect(quotedGroupCount(result!)).toBe(3);
  });

  it('escapes embedded double quotes in a token the same way as before', () => {
    const result = build('alpha be"ta gamma');
    expect(result).not.toBeNull();
    expect(result).toContain('"be""ta"');
  });
});
