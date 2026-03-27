/**
 * Worktree Project Resolution Tests
 *
 * Validates that project names resolve to the parent repository name
 * when running inside a git worktree, not the worktree directory name.
 *
 * Regression test for: #1081, #1317, #1500
 *
 * Sources:
 * - src/utils/project-name.ts (getProjectName, getProjectContext)
 * - src/utils/worktree.ts (detectWorktree)
 * - src/shared/paths.ts (getCurrentProjectName)
 * - src/services/worker/search/filters/ProjectFilter.ts (getCurrentProject)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectWorktree } from '../../src/utils/worktree.js';
import { getProjectName, getProjectContext } from '../../src/utils/project-name.js';

describe('Worktree Project Resolution (#1500)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'worktree-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Creates a fake worktree filesystem layout:
   *
   * tempDir/myproject/           ← main repo
   * ├── .git/                    ← real .git directory
   * │   └── worktrees/
   * │       └── noble-hare/      ← worktree metadata
   * └── .worktrees/
   *     └── noble-hare/          ← worktree checkout
   *         └── .git             ← file: "gitdir: .../myproject/.git/worktrees/noble-hare"
   */
  /** Add a worktree checkout to an existing repo directory */
  function addWorktree(repoPath: string, worktreeName: string): string {
    const worktreePath = join(repoPath, '.worktrees', worktreeName);
    const gitWorktreeMetaPath = join(repoPath, '.git', 'worktrees', worktreeName);

    mkdirSync(gitWorktreeMetaPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(worktreePath, '.git'),
      `gitdir: ${gitWorktreeMetaPath}\n`
    );

    return worktreePath;
  }

  /** Create a main repo with one worktree */
  function createWorktreeLayout(repoName: string, worktreeName: string) {
    const repoPath = join(tempDir, repoName);
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    const worktreePath = addWorktree(repoPath, worktreeName);
    return { repoPath, worktreePath };
  }

  describe('detectWorktree', () => {
    it('detects worktree and returns parent repo name', () => {
      const { worktreePath } = createWorktreeLayout('rewrite', 'noble-hare');

      const info = detectWorktree(worktreePath);

      expect(info.isWorktree).toBe(true);
      expect(info.parentProjectName).toBe('rewrite');
      expect(info.worktreeName).toBe('noble-hare');
    });

    it('returns not-a-worktree for main repo', () => {
      const { repoPath } = createWorktreeLayout('rewrite', 'noble-hare');

      const info = detectWorktree(repoPath);

      expect(info.isWorktree).toBe(false);
      expect(info.parentProjectName).toBeNull();
    });

    it('returns not-a-worktree for directory without .git', () => {
      const noGitDir = join(tempDir, 'no-git');
      mkdirSync(noGitDir, { recursive: true });

      const info = detectWorktree(noGitDir);

      expect(info.isWorktree).toBe(false);
    });
  });

  describe('getProjectContext', () => {
    it('returns parent project name as primary when in worktree', () => {
      const { worktreePath } = createWorktreeLayout('rewrite', 'noble-hare');

      const context = getProjectContext(worktreePath);

      // The primary project should be the PARENT repo, not the worktree dir
      expect(context.primary).toBe('rewrite');
      expect(context.parent).toBeNull();
      expect(context.isWorktree).toBe(true);
      expect(context.allProjects).toEqual(['rewrite']);
    });

    it('returns repo name as primary when NOT in worktree', () => {
      const { repoPath } = createWorktreeLayout('rewrite', 'noble-hare');

      const context = getProjectContext(repoPath);

      expect(context.primary).toBe('rewrite');
      expect(context.parent).toBeNull();
      expect(context.isWorktree).toBe(false);
      expect(context.allProjects).toEqual(['rewrite']);
    });

    it('all worktrees of same repo resolve to same primary project', () => {
      const repoName = 'rewrite';
      const { repoPath, worktreePath: wt1 } = createWorktreeLayout(repoName, 'noble-hare');
      const wt2Path = addWorktree(repoPath, 'jolly-condor');

      const ctx1 = getProjectContext(wt1);
      const ctx2 = getProjectContext(wt2Path);

      expect(ctx1.primary).toBe('rewrite');
      expect(ctx2.primary).toBe('rewrite');
      expect(ctx1.primary).toBe(ctx2.primary);
    });
  });

  describe('getProjectName', () => {
    it('returns parent repo name when in a worktree', () => {
      const { worktreePath } = createWorktreeLayout('rewrite', 'noble-hare');

      const name = getProjectName(worktreePath);

      // Should return 'rewrite', not 'noble-hare'
      expect(name).toBe('rewrite');
    });

    it('returns directory name when NOT in a worktree', () => {
      const { repoPath } = createWorktreeLayout('rewrite', 'noble-hare');

      const name = getProjectName(repoPath);

      expect(name).toBe('rewrite');
    });
  });
});
