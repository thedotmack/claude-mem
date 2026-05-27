
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
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

  describe('worktree isolation', () => {
    let tmp: string;
    let mainRepo: string;
    let worktreeCheckout: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = mkdtempSync(join(tmpdir(), 'cm-wt-'));
      mainRepo = join(tmp, 'main-repo');
      const worktreeGitDir = join(mainRepo, '.git', 'worktrees', 'my-worktree');
      worktreeCheckout = join(tmp, 'my-worktree');

      mkdirSync(worktreeGitDir, { recursive: true });
      mkdirSync(worktreeCheckout, { recursive: true });
      writeFileSync(
        join(worktreeCheckout, '.git'),
        `gitdir: ${worktreeGitDir}\n`
      );
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('uses parent/worktree composite as primary when in a worktree', () => {
      const ctx = getProjectContext(worktreeCheckout);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('main-repo/my-worktree');
      expect(ctx.parent).toBe('main-repo');
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/my-worktree']);
    });

    it('write-path call sites resolve to composite name in worktrees', () => {
      const project = getProjectContext(worktreeCheckout).primary;
      expect(project).toBe('main-repo/my-worktree');
      expect(project).not.toBe('main-repo');
      expect(project).not.toBe('my-worktree');
    });
  });

  describe('git root project naming (#2663)', () => {
    let tmp: string;
    let originalUseGitRoot: string | undefined;

    beforeEach(async () => {
      const { mkdtempSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      originalUseGitRoot = process.env.CLAUDE_MEM_USE_GIT_ROOT;
      tmp = mkdtempSync(join(tmpdir(), 'cm-git-root-'));
    });

    afterEach(async () => {
      const { rmSync } = await import('fs');

      if (originalUseGitRoot === undefined) {
        delete process.env.CLAUDE_MEM_USE_GIT_ROOT;
      } else {
        process.env.CLAUDE_MEM_USE_GIT_ROOT = originalUseGitRoot;
      }

      rmSync(tmp, { recursive: true, force: true });
    });

    it('keeps basename behavior when git root mode is false', async () => {
      const { mkdirSync } = await import('fs');
      const { join } = await import('path');
      const repo = join(tmp, 'repo-a');
      const nested = join(repo, 'src');

      process.env.CLAUDE_MEM_USE_GIT_ROOT = 'false';
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(nested, { recursive: true });

      expect(getProjectName(nested)).toBe('src');
      expect(getProjectContext(nested).primary).toBe('src');
    });

    it('uses nearest normal repository root when git root mode is true', async () => {
      const { mkdirSync } = await import('fs');
      const { join } = await import('path');
      const repo = join(tmp, 'code', 'repo-a');
      const nested = join(repo, 'src', 'features');

      process.env.CLAUDE_MEM_USE_GIT_ROOT = 'true';
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(nested, { recursive: true });

      expect(getProjectName(nested)).toBe('repo-a');
      expect(getProjectContext(nested).primary).toBe('repo-a');
    });

    it('falls back to cwd basename when git root mode finds no repository', async () => {
      const { mkdirSync } = await import('fs');
      const { join } = await import('path');
      const parent = join(tmp, 'code');

      process.env.CLAUDE_MEM_USE_GIT_ROOT = 'true';
      mkdirSync(parent, { recursive: true });

      expect(getProjectName(parent)).toBe('code');
      expect(getProjectContext(parent).primary).toBe('code');
    });

    it('recognizes a .git file as a repository root marker', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const repo = join(tmp, 'repo-file-git');
      const nested = join(repo, 'src');

      process.env.CLAUDE_MEM_USE_GIT_ROOT = 'true';
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(repo, '.git'), 'gitdir: ../actual-git-dir\n');

      expect(getProjectName(nested)).toBe('repo-file-git');
      expect(getProjectContext(nested).primary).toBe('repo-file-git');
    });

    it('uses parent/worktree project context from a worktree subdirectory when git root mode is true', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const mainRepo = join(tmp, 'main-repo');
      const worktreeCheckout = join(tmp, 'my-worktree');
      const worktreeNested = join(worktreeCheckout, 'packages', 'app');
      const worktreeGitDir = join(mainRepo, '.git', 'worktrees', 'my-worktree');

      process.env.CLAUDE_MEM_USE_GIT_ROOT = 'true';
      mkdirSync(worktreeGitDir, { recursive: true });
      mkdirSync(worktreeNested, { recursive: true });
      writeFileSync(
        join(worktreeCheckout, '.git'),
        `gitdir: ${worktreeGitDir}\n`
      );

      const ctx = getProjectContext(worktreeNested);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('main-repo/my-worktree');
      expect(ctx.parent).toBe('main-repo');
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/my-worktree']);
    });
  });
});
