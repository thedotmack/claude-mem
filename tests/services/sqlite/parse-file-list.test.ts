/**
 * Tests for parseFileList (fix for #1359)
 *
 * Validates safe JSON array parsing for files_read/files_modified DB columns
 * that may contain legacy bare path strings instead of JSON arrays.
 */
import { describe, it, expect } from 'bun:test';
import { parseFileList } from '../../../src/services/sqlite/observations/files.js';

describe('parseFileList', () => {
  it('returns [] for null', () => {
    expect(parseFileList(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(parseFileList(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseFileList('')).toEqual([]);
  });

  it('returns [] for empty JSON array', () => {
    expect(parseFileList('[]')).toEqual([]);
  });

  it('parses a normal JSON array', () => {
    expect(parseFileList('["/a/b.ts","/c/d.ts"]')).toEqual(['/a/b.ts', '/c/d.ts']);
  });

  it('wraps a bare path in an array instead of crashing', () => {
    expect(parseFileList('/Users/foo/bar.go')).toEqual(['/Users/foo/bar.go']);
  });

  it('wraps a Windows bare path in an array', () => {
    expect(parseFileList('C:\\Users\\foo\\bar.ts')).toEqual(['C:\\Users\\foo\\bar.ts']);
  });

  it('handles invalid JSON by treating value as single element', () => {
    expect(parseFileList('not valid json {')).toEqual(['not valid json {']);
  });

  it('wraps a JSON scalar string in an array', () => {
    expect(parseFileList('"single-file.ts"')).toEqual(['single-file.ts']);
  });
});
