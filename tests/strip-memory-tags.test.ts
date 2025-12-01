/**
 * Tests for stripMemoryTags function
 * Verifies tag stripping and type safety for dual-tag system
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripMemoryTagsFromJson } from '../dist/utils/tag-stripping.js';

// Alias for clarity in tests (this tests the JSON context version)
const stripMemoryTags = stripMemoryTagsFromJson;

describe('stripMemoryTags', () => {
  // Basic functionality tests - <claude-mem-context>
  it('should strip <claude-mem-context> tags', () => {
    const input = 'before <claude-mem-context>injected content</claude-mem-context> after';
    const expected = 'before  after';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  // Basic functionality tests - <private>
  it('should strip <private> tags', () => {
    const input = 'before <private>sensitive data</private> after';
    const expected = 'before  after';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should strip both tag types in one string', () => {
    const input = '<claude-mem-context>context</claude-mem-context> middle <private>private</private>';
    const expected = 'middle';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle nested tags', () => {
    const input = '<claude-mem-context>outer <private>inner</private> outer</claude-mem-context>';
    const expected = '';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle multiline content in tags', () => {
    const input = `before
<claude-mem-context>
line 1
line 2
line 3
</claude-mem-context>
after`;
    const expected = 'before\n\nafter';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle multiple tags of same type', () => {
    const input = '<private>first</private> middle <private>second</private>';
    const expected = 'middle';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should return empty string for content that is only tags', () => {
    const input = '<claude-mem-context>only this</claude-mem-context>';
    const expected = '';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle strings without tags', () => {
    const input = 'no tags here';
    const expected = 'no tags here';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle empty string', () => {
    const input = '';
    const expected = '';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should trim whitespace after stripping', () => {
    const input = '   <claude-mem-context>content</claude-mem-context>   ';
    const expected = '';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle malformed tags (unclosed)', () => {
    const input = '<claude-mem-context>unclosed tag content';
    const expected = '<claude-mem-context>unclosed tag content';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle tag-like strings that are not actual tags', () => {
    const input = 'This is not a <tag> but looks like one';
    const expected = 'This is not a <tag> but looks like one';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  // Type safety tests
  it('should handle non-string input safely (number)', () => {
    const input = 123 as any;
    const expected = '{}';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle non-string input safely (null)', () => {
    const input = null as any;
    const expected = '{}';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle non-string input safely (undefined)', () => {
    const input = undefined as any;
    const expected = '{}';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle non-string input safely (object)', () => {
    const input = { foo: 'bar' } as any;
    const expected = '{}';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  it('should handle non-string input safely (array)', () => {
    const input = ['test'] as any;
    const expected = '{}';
    assert.strictEqual(stripMemoryTags(input), expected);
  });

  // Real-world JSON scenarios
  it('should strip tags from JSON.stringify output', () => {
    const obj = {
      message: 'hello',
      context: '<claude-mem-context>past observation</claude-mem-context>',
      private: '<private>sensitive</private>'
    };
    const jsonStr = JSON.stringify(obj);
    const result = stripMemoryTags(jsonStr);

    // Tags should be stripped from the JSON string
    assert.ok(!result.includes('<claude-mem-context>'));
    assert.ok(!result.includes('</claude-mem-context>'));
    assert.ok(!result.includes('<private>'));
    assert.ok(!result.includes('</private>'));
  });

  it('should handle very large content efficiently', () => {
    const largeContent = 'x'.repeat(10000);
    const input = `<claude-mem-context>${largeContent}</claude-mem-context>`;
    const expected = '';
    assert.strictEqual(stripMemoryTags(input), expected);
  });
});
