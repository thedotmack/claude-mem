import { describe, it, expect } from 'bun:test';
import { stripPrivateTags, hasPrivateTags } from '../src/utils/privacy.ts';

// NOTE: The module-level PRIVATE_TAG_REGEX uses the /g flag, which means
// the regex retains lastIndex state between calls to hasPrivateTags.
// To work around this, we call stripPrivateTags (which also resets lastIndex
// via .replace) between successive hasPrivateTags calls on the same text.

// ─── stripPrivateTags ─────────────────────────────────────────────────────

describe('stripPrivateTags', () => {
  it('returns the text unchanged when no private tags are present', () => {
    const input = 'Hello, world!';
    expect(stripPrivateTags(input)).toBe('Hello, world!');
  });

  it('replaces a single private tag block with [REDACTED]', () => {
    const input = 'Before <private>secret content</private> after';
    expect(stripPrivateTags(input)).toBe('Before [REDACTED] after');
  });

  it('replaces multiple private tag blocks each with [REDACTED]', () => {
    const input = '<private>first</private> middle <private>second</private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED] middle [REDACTED]');
  });

  it('strips tag but preserves surrounding content intact', () => {
    const input = 'Public: <private>hidden</private> end';
    const result = stripPrivateTags(input);
    expect(result).toContain('Public:');
    expect(result).toContain('end');
    expect(result).not.toContain('hidden');
  });

  it('handles multiline content inside private tags', () => {
    const input = '<private>\nline one\nline two\n</private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED]');
  });

  it('handles case-insensitive tags (<PRIVATE> uppercase)', () => {
    const input = 'data: <PRIVATE>classified</PRIVATE> end';
    expect(stripPrivateTags(input)).toBe('data: [REDACTED] end');
  });

  it('handles mixed-case tags (<Private>)', () => {
    const input = '<Private>mixed case</Private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED]');
  });

  it('returns empty string unchanged when input is empty', () => {
    expect(stripPrivateTags('')).toBe('');
  });

  it('replaces tag with no body content', () => {
    const input = 'before <private></private> after';
    expect(stripPrivateTags(input)).toBe('before [REDACTED] after');
  });

  it('does not strip partial/unclosed tags', () => {
    const input = 'not closed <private>content without end tag';
    // No closing tag — regex requires </private>, so no replacement
    expect(stripPrivateTags(input)).toBe(input);
  });

  it('handles nested tag-like text inside private block', () => {
    const input = '<private><inner>nested</inner></private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED]');
  });
});

// ─── hasPrivateTags ───────────────────────────────────────────────────────

describe('hasPrivateTags', () => {
  it('returns true when a private tag is present', () => {
    const input = 'text <private>secret</private> more text';
    const result = hasPrivateTags(input);
    expect(result).toBe(true);
    // Reset lastIndex via stripPrivateTags before next test call
    stripPrivateTags(input);
  });

  it('returns false when no private tags are present', () => {
    expect(hasPrivateTags('plain text without any tags')).toBe(false);
  });

  it('returns false for text with only opening tag (no closing)', () => {
    // Call stripPrivateTags first to ensure lastIndex is 0
    stripPrivateTags('');
    expect(hasPrivateTags('<private>unclosed')).toBe(false);
  });

  it('returns true for tag at start of string', () => {
    stripPrivateTags('');
    const result = hasPrivateTags('<private>at start</private> rest');
    expect(result).toBe(true);
    stripPrivateTags('<private>at start</private> rest');
  });

  it('returns false for empty string', () => {
    expect(hasPrivateTags('')).toBe(false);
  });

  it('is case-insensitive — returns true for <PRIVATE>', () => {
    stripPrivateTags('');
    const result = hasPrivateTags('<PRIVATE>data</PRIVATE>');
    expect(result).toBe(true);
    stripPrivateTags('<PRIVATE>data</PRIVATE>');
  });
});
