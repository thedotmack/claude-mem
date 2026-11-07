import { describe, it, expect } from 'bun:test';
import { normalizeTitle, tokenizeWs } from '../../src/services/dedup/normalize.js';

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('Fixed   the   BUG!!!')).toBe('fixed the bug');
  });

  it('treats punctuation-separated variants as equal (for Tier-0 exact match)', () => {
    expect(normalizeTitle('On-Demand Checkpoint.')).toBe(normalizeTitle('on demand checkpoint'));
  });

  it('is idempotent', () => {
    const once = normalizeTitle('Hardened On-Demand Checkpoint!');
    expect(normalizeTitle(once)).toBe(once);
  });

  it('distinguishes genuinely different titles (negative)', () => {
    expect(normalizeTitle('Added the relevance_count column'))
      .not.toBe(normalizeTitle('Removed the relevance_count column'));
  });

  it('handles null/empty', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle('   ')).toBe('');
  });

  it('collapses punctuation-only and emoji-only titles to empty (precondition for the Tier-0 empty-guard)', () => {
    // These are the inputs that make the empty-normal-form data-loss guard load-bearing.
    expect(normalizeTitle('!!!')).toBe('');
    expect(normalizeTitle('...')).toBe('');
    expect(normalizeTitle('🔵')).toBe('');
    expect(normalizeTitle('🎉🎉')).toBe('');
  });
});

describe('tokenizeWs', () => {
  it('splits on whitespace only and lowercases', () => {
    expect(tokenizeWs('Added rdlp-redact to rdlp-api')).toEqual(['added', 'rdlp-redact', 'to', 'rdlp-api']);
  });

  it('PRESERVES compound identifiers as single tokens (veto correctness)', () => {
    // If these split, idf("api") would be common and the IDF-veto would fail to fire.
    expect(tokenizeWs('Pinned versions in ffmpeg-7.1.conf')).toContain('ffmpeg-7.1.conf');
    expect(tokenizeWs('clippy violation in download.rs')).toContain('download.rs');
  });

  it('keeps version/identifier tokens distinct (negative)', () => {
    expect(tokenizeWs('ffmpeg-7.1.conf')).not.toEqual(tokenizeWs('ffmpeg-6.1.conf'));
  });

  it('returns [] for empty/whitespace/null', () => {
    expect(tokenizeWs('')).toEqual([]);
    expect(tokenizeWs('   ')).toEqual([]);
    expect(tokenizeWs(null)).toEqual([]);
  });
});
