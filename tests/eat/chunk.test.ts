import { describe, expect, it } from 'bun:test';
import { chunkText } from '../../src/services/worker/eat/chunk.js';

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('returns no chunks for whitespace-only input', () => {
    expect(chunkText('  \n\n   \n\n ', 100)).toEqual([]);
  });

  it('rejects a non-positive or non-integer chunk size instead of looping forever', () => {
    expect(() => chunkText('content', 0)).toThrow(RangeError);
    expect(() => chunkText('content', -1)).toThrow(RangeError);
    expect(() => chunkText('content', 1.5)).toThrow(RangeError);
  });

  it('returns one chunk for a single small paragraph', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world']);
  });

  it('greedily packs paragraphs up to maxChars', () => {
    expect(chunkText('aaa\n\nbbb\n\nccc', 8)).toEqual(['aaa\n\nbbb', 'ccc']);
  });

  it('starts a new chunk when packing would exceed maxChars', () => {
    expect(chunkText('aaaa\n\nbbbb\n\ncccc', 9)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('hard-splits a single oversized paragraph', () => {
    const oversized = 'x'.repeat(25);
    expect(chunkText(oversized, 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('flushes the current chunk before hard-splitting an oversized paragraph', () => {
    const oversized = 'y'.repeat(12);
    expect(chunkText(`aaa\n\n${oversized}\n\nbbb`, 10)).toEqual(['aaa', 'y'.repeat(10), 'yy', 'bbb']);
  });

  it('trims paragraph whitespace and drops blank paragraphs', () => {
    expect(chunkText('  aaa  \n\n\n\n  bbb  ', 100)).toEqual(['aaa\n\nbbb']);
  });

  it('is deterministic', () => {
    const input = 'para one\n\npara two\n\n' + 'z'.repeat(30) + '\n\npara three';
    expect(chunkText(input, 12)).toEqual(chunkText(input, 12));
  });
});
