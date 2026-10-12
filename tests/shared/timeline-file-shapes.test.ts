import { describe, expect, it } from 'bun:test';
import { extractFirstFile, parseJsonArray } from '../../src/shared/timeline-formatting.js';

describe('stored file array shape admission', () => {
  it('keeps only string file paths in decoded arrays', () => {
    expect(parseJsonArray('[null,17,{},"src/app.ts"]')).toEqual(['src/app.ts']);
  });

  it('uses a valid later modified path instead of throwing on a malformed first entry', () => {
    expect(extractFirstFile('[null,"/work/src/app.ts"]', '/work')).toBe('src/app.ts');
  });

  it('falls back to files_read when modified entries are all malformed', () => {
    expect(extractFirstFile('[42,{}]', '/work', '["/work/README.md"]')).toBe('README.md');
  });
});
