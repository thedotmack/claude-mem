
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
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

  describe('Phase 7 — repo-relative project identity', () => {
    let tmp: string;
    let repoRoot: string;
    let nestedDir: string;
    let overrideNestedDir: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, realpathSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      // macOS /tmp symlinks to /private/tmp; realpath so `git --show-toplevel`
      // (which returns the canonical path) matches our expectations.
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-reporoot-')));
      repoRoot = join(tmp, 'my-real-repo');
      nestedDir = join(repoRoot, 'packages', 'deeply', 'nested');
      overrideNestedDir = join(repoRoot, 'override-package', 'deeply', 'nested');
      mkdirSync(nestedDir, { recursive: true });
      mkdirSync(overrideNestedDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('deep subdirectory inside a repo yields a repo-relative key', () => {
      expect(getProjectName(nestedDir)).toBe('my-real-repo/packages/deeply/nested');
    });

    it('repo root itself yields the repo-root name', () => {
      expect(getProjectName(repoRoot)).toBe('my-real-repo');
    });

    it('context preserves root alias while making the subdirectory primary', () => {
      const ctx = getProjectContext(nestedDir);
      expect(ctx.primary).toBe('my-real-repo/packages/deeply/nested');
      expect(ctx.gitRootKey).toBe('my-real-repo');
      expect(ctx.repoRelativeKey).toBe('packages/deeply/nested');
      expect(ctx.cwdKey).toBe('nested');
      expect(ctx.aliases).toEqual(['my-real-repo']);
      expect(ctx.allProjects).toEqual(['my-real-repo', 'my-real-repo/packages/deeply/nested']);
    });

    it('honors .claude-mem.json projectName override as primary while retaining aliases', async () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        `${repoRoot}/override-package/.claude-mem.json`,
        JSON.stringify({ projectName: 'explicit-monorepo-package' })
      );

      const ctx = getProjectContext(overrideNestedDir);
      expect(ctx.primary).toBe('explicit-monorepo-package');
      expect(ctx.userOverride).toBe('explicit-monorepo-package');
      expect(ctx.gitRootKey).toBe('my-real-repo');
      expect(ctx.repoRelativeKey).toBe('override-package/deeply/nested');
      expect(ctx.allProjects).toEqual([
        'my-real-repo',
        'my-real-repo/override-package/deeply/nested',
        'explicit-monorepo-package',
      ]);
    });

    it('non-repo path falls back to basename(cwd)', () => {
      // A path that does not exist (and therefore cannot be in a repo) must
      // fall back to basename(cwd) rather than throwing or returning a root.
      expect(getProjectName('/no/such/dir/standalone-folder')).toBe('standalone-folder');
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
    expect(ctx.cwdKey).toBe('my-project');
    expect(ctx.gitRootKey).toBeNull();
    expect(ctx.repoRelativeKey).toBeNull();
    expect(ctx.userOverride).toBeNull();
    expect(ctx.aliases).toEqual([]);
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
    expect(ctx.allProjects).toEqual(['unknown-project']);
    expect(ctx.gitRootKey).toBeNull();
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
      expect(ctx.gitRootKey).toBe('main-repo/my-worktree');
      expect(ctx.repoRelativeKey).toBeNull();
    });

    it('write-path call sites resolve to composite name in worktrees', () => {
      const project = getProjectContext(worktreeCheckout).primary;
      expect(project).toBe('main-repo/my-worktree');
      expect(project).not.toBe('main-repo');
      expect(project).not.toBe('my-worktree');
    });
  });
});
