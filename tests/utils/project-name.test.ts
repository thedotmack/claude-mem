/**
 * Project Name Tests
 *
 * Tests tilde expansion and project name extraction.
 * Source: src/utils/project-name.ts
 */

import { describe, it, expect } from 'bun:test';
import { homedir } from 'os';
import { getProjectName, getProjectContext } from '../../src/utils/project-name.js';

describe('getProjectName', () => {
  describe('tilde expansion', () => {
    it('resolves bare ~ to home directory basename', () => {
      const home = homedir();
      const expected = home.split('/').pop() || home.split('\\').pop() || '';
      expect(getProjectName('~')).toBe(expected);
    });

    it('resolves ~/subpath to subpath', () => {
      expect(getProjectName('~/projects/my-app')).toBe('my-app');
    });

    it('resolves ~/ to home directory basename', () => {
      const home = homedir();
      const expected = home.split('/').pop() || home.split('\\').pop() || '';
      expect(getProjectName('~/')).toBe(expected);
    });
  });

  describe('normal paths', () => {
    it('extracts basename from absolute path', () => {
      expect(getProjectName('/home/user/my-project')).toBe('my-project');
    });

    it('extracts basename from nested path', () => {
      expect(getProjectName('/Users/test/work/deep/nested/project')).toBe('project');
    });

    it('handles trailing slash', () => {
      expect(getProjectName('/home/user/my-project/')).toBe('my-project');
    });
  });

  describe('edge cases', () => {
    it('returns unknown-project for null', () => {
      expect(getProjectName(null)).toBe('unknown-project');
    });

    it('returns unknown-project for undefined', () => {
      expect(getProjectName(undefined)).toBe('unknown-project');
    });

    it('returns unknown-project for empty string', () => {
      expect(getProjectName('')).toBe('unknown-project');
    });

    it('returns unknown-project for whitespace', () => {
      expect(getProjectName('   ')).toBe('unknown-project');
    });
  });

  describe('realistic scenarios from #1478', () => {
    it('handles ~ the same as full home path', () => {
      const home = homedir();
      expect(getProjectName('~')).toBe(getProjectName(home));
    });

    it('handles ~/projects/app the same as /full/path/projects/app', () => {
      const home = homedir();
      expect(getProjectName('~/projects/app')).toBe(
        getProjectName(`${home}/projects/app`)
      );
    });
  });
});

describe('getProjectContext', () => {
  it('returns primary project name for normal path', () => {
    const ctx = getProjectContext('/home/user/my-project');
    expect(ctx.primary).toBe('my-project');
    expect(ctx.parent).toBeNull();
    expect(ctx.isWorktree).toBe(false);
    expect(ctx.allProjects).toEqual(['my-project']);
  });

  it('resolves ~ path correctly', () => {
    const home = homedir();
    const ctx = getProjectContext('~');
    const ctxHome = getProjectContext(home);
    expect(ctx.primary).toBe(ctxHome.primary);
  });

  it('returns unknown-project context for null', () => {
    const ctx = getProjectContext(null);
    expect(ctx.primary).toBe('unknown-project');
    expect(ctx.parent).toBeNull();
  });
});
