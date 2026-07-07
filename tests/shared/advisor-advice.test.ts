import { describe, it, expect } from 'bun:test';
import { stringifyAdvice } from '../../src/shared/advisor-advice.js';

describe('stringifyAdvice', () => {
  it('passes plain strings through, trimmed', () => {
    expect(stringifyAdvice('  advice text  ')).toBe('advice text');
  });

  it('joins Anthropic-style text content blocks', () => {
    expect(stringifyAdvice([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])).toBe('first\nsecond');
  });

  it('ignores non-text blocks in a content array', () => {
    expect(stringifyAdvice([
      { type: 'tool_use', text: 'ignored' },
      { type: 'text', text: 'kept' },
    ])).toBe('kept');
  });

  it('unwraps an object with a text field', () => {
    expect(stringifyAdvice({ text: 'advice' })).toBe('advice');
  });

  it('unwraps an object with a nested content array', () => {
    expect(stringifyAdvice({ content: [{ type: 'text', text: 'nested advice' }] })).toBe('nested advice');
  });

  it('returns empty string for null/undefined', () => {
    expect(stringifyAdvice(null)).toBe('');
    expect(stringifyAdvice(undefined)).toBe('');
  });

  it('falls back to JSON.stringify for unrecognized shapes', () => {
    expect(stringifyAdvice({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });
});
