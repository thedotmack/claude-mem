/**
 * Tests for parseSummary (fix for #1360)
 *
 * Validates that false-positive summary matches (no sub-tags) are rejected
 * while real summaries — even with some missing fields — are still saved.
 */
import { describe, it, expect } from 'bun:test';
import { parseSummary } from '../../src/sdk/parser.js';

describe('parseSummary', () => {
  it('returns null when no <summary> tag present and coercion disabled', () => {
    expect(parseSummary('<observation><title>foo</title></observation>')).toBeNull();
  });

  it('returns null when no <summary> or <observation> tags present', () => {
    expect(parseSummary('Some plain text response without any XML tags')).toBeNull();
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

  // Observation-to-summary coercion tests (#1633)
  it('coerces <observation> with content into a summary when coerceFromObservation=true (#1633)', () => {
    const result = parseSummary('<observation><title>foo</title></observation>', undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('foo');
    expect(result?.completed).toBe('foo');
  });

  it('coerces observation with narrative into summary with investigated field (#1633)', () => {
    const text = `<observation>
      <type>refactor</type>
      <title>UObjectArray refactored</title>
      <narrative>Removed local XXXX and migrated to new pattern</narrative>
    </observation>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('UObjectArray refactored');
    expect(result?.investigated).toBe('Removed local XXXX and migrated to new pattern');
  });

  it('coerces observation with facts into summary with learned field (#1633)', () => {
    const text = `<observation>
      <type>discovery</type>
      <title>JWT token handling</title>
      <facts>
        <fact>Tokens expire after 1 hour</fact>
        <fact>Refresh flow uses rotating keys</fact>
      </facts>
    </observation>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('JWT token handling');
    expect(result?.learned).toBe('Tokens expire after 1 hour; Refresh flow uses rotating keys');
  });

  it('coerces observation with subtitle into completed field (#1633)', () => {
    const text = `<observation>
      <type>config</type>
      <title>Database migration</title>
      <subtitle>Added new index for performance</subtitle>
    </observation>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.completed).toBe('Database migration — Added new index for performance');
  });

  it('returns null for empty observation even with coercion enabled (#1633)', () => {
    const text = `<observation><type>config</type></observation>`;
    expect(parseSummary(text, undefined, true)).toBeNull();
  });

  it('prefers <summary> tags over observation coercion when both present (#1633)', () => {
    const text = `<observation><title>obs title</title></observation>
    <summary><request>summary request</request></summary>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('summary request');
  });

  it('falls back to observation coercion when <summary> matches but has empty sub-tags (#1633)', () => {
    // LLM wraps an empty summary around real observation content — without the
    // fallback, the empty-subtag guard (#1360) rejects the summary and we lose
    // the observation content, resurrecting the retry loop.
    const text = `<summary></summary>
      <observation>
        <title>the real work</title>
        <narrative>what actually happened</narrative>
      </observation>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('the real work');
    expect(result?.investigated).toBe('what actually happened');
  });

  it('empty <summary> with no observation content still returns null (coercion disabled)', () => {
    const text = '<summary></summary>';
    expect(parseSummary(text, undefined, true)).toBeNull();
  });

  it('skips empty leading observation blocks and coerces from the first populated one (#1633)', () => {
    const text = `<observation><type>discovery</type></observation>
      <observation>
        <type>bugfix</type>
        <title>second block has content</title>
        <narrative>fixed the crash</narrative>
      </observation>`;
    const result = parseSummary(text, undefined, true);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('second block has content');
    expect(result?.investigated).toBe('fixed the crash');
  });
});
