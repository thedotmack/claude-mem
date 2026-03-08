/**
 * Git Root Detection Tests
 *
 * Tests walking up the directory tree to find the nearest .git root.
 * Source: src/utils/git-root.ts
 */
import { describe, it, expect } from 'bun:test';
import { findGitRoot } from '../../src/utils/git-root.js';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

describe('findGitRoot', () => {
  describe('with no git repo', () => {
    it('returns null for a directory with no .git', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
      try {
        expect(findGitRoot(tmp)).toBeNull();
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('returns null for null input', () => {
      expect(findGitRoot(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(findGitRoot('')).toBeNull();
    });
  });

  describe('with a git repo', () => {
    it('finds .git in the current directory', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
      try {
        mkdirSync(path.join(tmp, '.git'));
        expect(findGitRoot(tmp)).toBe(tmp);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('finds .git by walking up from a subdirectory', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
      try {
        mkdirSync(path.join(tmp, '.git'));
        const subdir = path.join(tmp, 'src', 'utils');
        mkdirSync(subdir, { recursive: true });
        expect(findGitRoot(subdir)).toBe(tmp);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('finds .git as a file (worktree)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
      try {
        writeFileSync(path.join(tmp, '.git'), 'gitdir: /some/other/path');
        const subdir = path.join(tmp, 'src');
        mkdirSync(subdir, { recursive: true });
        expect(findGitRoot(subdir)).toBe(tmp);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });
});
