import { describe, expect, it } from 'bun:test';
import { makeFolderChildMatcher } from '../../src/cli/claude-md-commands.js';

// Windows-shaped evidence, checked on any OS (no path on disk is touched).
describe('folder CLAUDE.md evidence matcher (Windows paths)', () => {
  const isChild = makeFolderChildMatcher('src\\Auth', 'C:\\repo');

  it('accepts a direct child whose folder differs only in case', () => {
    expect(isChild('C:\\repo\\src\\Auth\\login.ts')).toBe(true);
    expect(isChild('c:\\Repo\\SRC\\auth\\login.ts')).toBe(true);
  });

  it('accepts the same folder in another checkout of the project', () => {
    expect(isChild('D:\\old-clone\\src\\Auth\\login.ts')).toBe(true);
  });

  it('rejects a same-named folder nested inside this checkout, and deeper files', () => {
    expect(isChild('C:\\repo\\packages\\widget\\src\\Auth\\button.ts')).toBe(false);
    expect(isChild('C:\\repo\\src\\Auth\\nested\\deep.ts')).toBe(false);
  });
});
