// where.exe searches the current directory before PATH, and hooks run with the
// user's project as cwd, so a planted bun.exe / claude.exe / codex.exe there
// must never be returned. isCurrentDirectoryCandidate is the shared filter.
import { describe, expect, it } from 'bun:test';
import { isCurrentDirectoryCandidate } from '../../src/shared/spawn.js';

describe('isCurrentDirectoryCandidate', () => {
  const cwd = 'C:\\Users\\dev\\project';

  it('matches a Windows path directly inside cwd, even on a POSIX host', () => {
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\project\\bun.exe', cwd)).toBe(true);
  });

  it('ignores case, separator style and a trailing separator on cwd', () => {
    expect(isCurrentDirectoryCandidate('c:\\USERS\\Dev\\Project\\bun.exe', cwd)).toBe(true);
    expect(isCurrentDirectoryCandidate('C:/Users/dev/project/bun.exe', cwd)).toBe(true);
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\project\\bun.exe', `${cwd}\\`)).toBe(true);
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\project\\bun.exe', 'C:/Users/dev/project/')).toBe(true);
  });

  it('does not match PATH directories, subdirectories or look-alike siblings', () => {
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\.bun\\bin\\bun.exe', cwd)).toBe(false);
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\project\\bin\\bun.exe', cwd)).toBe(false);
    expect(isCurrentDirectoryCandidate('C:\\Users\\dev\\project-tools\\bun.exe', cwd)).toBe(false);
  });

  it('handles POSIX paths', () => {
    expect(isCurrentDirectoryCandidate('/home/dev/project/bun', '/home/dev/project')).toBe(true);
    expect(isCurrentDirectoryCandidate('/home/dev/.bun/bin/bun', '/home/dev/project')).toBe(false);
  });
});
