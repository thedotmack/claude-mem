/**
 * Tests for parseSummary (fix for #1360)
 *
 * Validates that false-positive summary matches (no sub-tags) are rejected
 * while real summaries — even with some missing fields — are still saved.
 */
import { describe, it, expect } from 'bun:test';
import { parseSummary } from '../../src/sdk/parser.js';

describe('parseSummary', () => {
  it('returns null when no <summary> tag present', () => {
    expect(parseSummary('<observation><title>foo</title></observation>')).toBeNull();
  });

  it('returns null when <summary> has no sub-tags (false positive — fix for #1360)', () => {
    // This is the bug: observation response accidentally contains <summary>some text</summary>
    expect(parseSummary('<observation>done <summary>some content here</summary></observation>')).toBeNull();
  });

  it('returns null for bare <summary> with only plain text, no sub-tags', () => {
    expect(parseSummary('<summary>This session was productive.</summary>')).toBeNull();
  });

  it('returns summary when at least one sub-tag is present (respects maintainer note)', () => {
    const text = `<summary><request>Fix the bug</request></summary>`;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('Fix the bug');
    expect(result?.investigated).toBeNull();
    expect(result?.learned).toBeNull();
  });

  it('returns full summary when all fields are present', () => {
    const text = `<summary>
      <request>Fix login bug</request>
      <investigated>Auth flow and JWT expiry</investigated>
      <learned>Token was expiring too soon</learned>
      <completed>Extended token TTL to 24h</completed>
      <next_steps>Monitor error rates</next_steps>
    </summary>`;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('Fix login bug');
    expect(result?.investigated).toBe('Auth flow and JWT expiry');
    expect(result?.learned).toBe('Token was expiring too soon');
    expect(result?.completed).toBe('Extended token TTL to 24h');
    expect(result?.next_steps).toBe('Monitor error rates');
  });

  it('returns null when skip_summary tag is present', () => {
    expect(parseSummary('<skip_summary reason="no work done"/>')).toBeNull();
  });
});
