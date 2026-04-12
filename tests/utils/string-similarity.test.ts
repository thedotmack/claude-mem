/**
 * Tests for string similarity utility
 */

import { describe, it, expect } from 'bun:test';
import { similarity, normalizeForComparison } from '../../src/utils/string-similarity.js';

describe('normalizeForComparison', () => {
  it('collapses multiple spaces', () => {
    expect(normalizeForComparison('hello   world')).toBe('hello world');
  });

  it('converts tabs and newlines to spaces', () => {
    expect(normalizeForComparison('hello\tworld\nfoo')).toBe('hello world foo');
  });

  it('trims and lowercases', () => {
    expect(normalizeForComparison('  Hello World  ')).toBe('hello world');
  });
});

describe('similarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1.0);
  });

  it('returns 1.0 for strings differing only in whitespace/case', () => {
    expect(similarity('Hello  World', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for empty vs non-empty', () => {
    expect(similarity('', 'hello')).toBe(0.0);
  });

  it('returns 1.0 for both empty', () => {
    expect(similarity('', '')).toBe(1.0);
  });

  it('returns high similarity for minor differences', () => {
    const s = similarity(
      'The authentication feature is now fully implemented and tested.',
      'The authentication feature is now fully implemented and tested!'
    );
    expect(s).toBeGreaterThan(0.95);
  });

  it('returns low similarity for very different strings', () => {
    const s = similarity(
      'Added JWT authentication middleware.',
      'Created migration for new users table.'
    );
    expect(s).toBeLessThan(0.5);
  });

  it('handles Unicode normalization', () => {
    // é as single codepoint vs e + combining accent
    const s = similarity('caf\u00e9', 'cafe\u0301');
    expect(s).toBe(1.0);
  });

  it('returns 0.0 for strings exceeding max length (performance guard)', () => {
    const long1 = 'a'.repeat(1001);
    const long2 = 'a'.repeat(1001);
    // Identical but over 1000 chars — skips Levenshtein, falls back to exact match
    // After normalization these ARE identical, so should return 1.0
    expect(similarity(long1, long2)).toBe(1.0);

    // Different long strings — should return 0.0 (skips expensive comparison)
    const long3 = 'a'.repeat(1001);
    const long4 = 'b'.repeat(1001);
    expect(similarity(long3, long4)).toBe(0.0);
  });
});
