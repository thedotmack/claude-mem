import { describe, it, expect } from 'bun:test';
import { isToolSkipped } from '../../src/shared/is-tool-skipped.js';

describe('isToolSkipped (CLAUDE_MEM_SKIP_TOOLS)', () => {
  it('matches trimmed entries case-insensitively', () => {
    expect(isToolSkipped('Read', ' read ,TodoWrite')).toBe(true);
    expect(isToolSkipped('todowrite', 'Read, TodoWrite')).toBe(true);
    expect(isToolSkipped('write_file', 'Write_File')).toBe(true);
  });

  it('does not match tools that are not listed, or partial names', () => {
    expect(isToolSkipped('Bash', 'Read,TodoWrite')).toBe(false);
    expect(isToolSkipped('Rea', 'Read')).toBe(false);
  });

  it('skips nothing for an empty or missing setting', () => {
    expect(isToolSkipped('Read', '')).toBe(false);
    expect(isToolSkipped('Read', ' , ,')).toBe(false);
    expect(isToolSkipped('Read', undefined)).toBe(false);
  });
});
