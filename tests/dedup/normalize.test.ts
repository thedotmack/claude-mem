import { describe, it, expect } from 'bun:test';
import { normalizeTitle, tokenizeWs } from '../../src/services/dedup/normalize.js';

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('Fixed   the   BUG!!!')).toBe('fixed the bug');
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

  it('returns [] for empty/whitespace/null', () => {
    expect(tokenizeWs('')).toEqual([]);
    expect(tokenizeWs('   ')).toEqual([]);
    expect(tokenizeWs(null)).toEqual([]);
  });
});
