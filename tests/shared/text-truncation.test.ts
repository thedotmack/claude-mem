import { describe, expect, test } from 'bun:test';
import {
  truncateLargeText,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  HEAD_KEEP_LENGTH,
  TAIL_KEEP_LENGTH
} from '../../src/shared/text-truncation.js';

describe('truncateLargeText', () => {
  test('returns empty string for undefined input', () => {
    expect(truncateLargeText(undefined)).toBe('');
  });

  test('returns empty string for empty input', () => {
    expect(truncateLargeText('')).toBe('');
  });

  test('returns original text when under max length', () => {
    const shortText = 'This is a short message';
    expect(truncateLargeText(shortText)).toBe(shortText);
  });

  test('returns original text when exactly at max length', () => {
    const exactText = 'a'.repeat(MAX_ASSISTANT_MESSAGE_LENGTH);
    expect(truncateLargeText(exactText)).toBe(exactText);
  });

  test('truncates text when over max length', () => {
    const longText = 'a'.repeat(MAX_ASSISTANT_MESSAGE_LENGTH + 10000);
    const result = truncateLargeText(longText);
    expect(result.length).toBeLessThan(longText.length);
  });

  test('preserves head and tail portions', () => {
    const head = 'HEAD'.repeat(2500); // 10000 chars
    const middle = 'MIDDLE'.repeat(10000); // 60000 chars
    const tail = 'TAIL'.repeat(10000); // 40000 chars
    const longText = head + middle + tail;

    const result = truncateLargeText(longText);

    // Should contain the head
    expect(result.startsWith('HEAD')).toBe(true);
    // Should contain the tail
    expect(result.endsWith('TAIL')).toBe(true);
    // Should have truncation marker
    expect(result).toContain('truncated');
  });

  test('includes character count in truncation message', () => {
    const longText = 'x'.repeat(100000);
    const result = truncateLargeText(longText);

    // Should mention how many chars were truncated
    expect(result).toContain('characters truncated');
  });

  test('respects custom max length', () => {
    const text = 'a'.repeat(1000);
    const result = truncateLargeText(text, 500, 100, 100);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('truncated');
  });

  test('handles text with newlines', () => {
    const textWithNewlines = 'line1\nline2\nline3\n'.repeat(5000);
    const result = truncateLargeText(textWithNewlines);
    // Should not throw and should contain newlines
    expect(result).toContain('\n');
  });

  test('handles unicode text', () => {
    const unicodeText = '你好世界🌍'.repeat(10000);
    const result = truncateLargeText(unicodeText);
    // Should not throw
    expect(typeof result).toBe('string');
  });
});
