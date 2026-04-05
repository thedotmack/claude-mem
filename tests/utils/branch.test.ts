import { describe, it, expect } from 'bun:test';
import { getCurrentBranch, getMergedBranches } from '../../src/utils/branch.js';

describe('getCurrentBranch', () => {
  it('returns a branch name in a git repo', () => {
    const branch = getCurrentBranch(process.cwd());
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe('string');
  });

  it('returns null for non-git directory', () => {
    const branch = getCurrentBranch('/tmp');
    expect(branch).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    const branch = getCurrentBranch('/nonexistent/path/that/does/not/exist');
    expect(branch).toBeNull();
  });

  it('defaults to process.cwd() when no cwd provided', () => {
    const branch = getCurrentBranch();
    expect(typeof branch === 'string' || branch === null).toBe(true);
  });
});

describe('getMergedBranches', () => {
  it('returns an array of branch names in a git repo', () => {
    const branches = getMergedBranches(process.cwd());
    expect(Array.isArray(branches)).toBe(true);
    expect(branches.length).toBeGreaterThan(0);
  });

  it('returns empty array for non-git directory', () => {
    const branches = getMergedBranches('/tmp');
    expect(branches).toEqual([]);
  });

  it('returns empty array for non-existent directory', () => {
    const branches = getMergedBranches('/nonexistent/path/that/does/not/exist');
    expect(branches).toEqual([]);
  });

  it('limits results to MAX_MERGED_BRANCHES', () => {
    const branches = getMergedBranches(process.cwd());
    expect(branches.length).toBeLessThanOrEqual(50);
  });
});
