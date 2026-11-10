import { describe, it, expect } from 'bun:test';
import { parseFileList } from '../../../src/services/sqlite/observations/files.js';

describe('parseFileList', () => {
  it.each([
    [null, []],
    [undefined, []],
    ['', []],
    ['[]', []],
    ['["/a/b.ts","/c/d.ts"]', ['/a/b.ts', '/c/d.ts']],
    ['/Users/foo/bar.go', ['/Users/foo/bar.go']],
    ['C:\\Users\\foo\\bar.ts', ['C:\\Users\\foo\\bar.ts']],
    ['not valid json {', ['not valid json {']],
    ['"single-file.ts"', ['single-file.ts']],
  ] as const)('parses %j as %j', (input, expected) => {
    expect(parseFileList(input)).toEqual(expected);
  });
});
