
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

  describe('#2663 — name derived from git repo root', () => {
    let tmp: string;
    let repoRoot: string;
    let nestedDir: string;

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
      mkdirSync(nestedDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('deep subdirectory inside a repo yields the repo-root name', () => {
      expect(getProjectName(nestedDir)).toBe('my-real-repo');
    });

    it('repo root itself yields the repo-root name', () => {
      expect(getProjectName(repoRoot)).toBe('my-real-repo');
    });

    it('non-repo path falls back to basename(cwd)', () => {
      // A path that does not exist (and therefore cannot be in a repo) must
      // fall back to basename(cwd) rather than throwing or returning a root.
      expect(getProjectName('/no/such/dir/standalone-folder')).toBe('standalone-folder');
    });
  });

  describe('.claude-mem.json projectName override', () => {
    let tmp: string;
    let repoRoot: string;
    let nestedDir: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-cfgname-')));
      repoRoot = join(tmp, 'my-app-2');
      nestedDir = join(repoRoot, 'packages', 'core');
      mkdirSync(nestedDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repoRoot });
      writeFileSync(
        join(repoRoot, '.claude-mem.json'),
        JSON.stringify({ projectName: 'my-app' })
      );
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('overrides the repo-root name at the project root', () => {
      expect(getProjectName(repoRoot)).toBe('my-app');
    });

    it('is inherited by nested subdirectories (walks up to the config)', () => {
      expect(getProjectName(nestedDir)).toBe('my-app');
    });

    it('getProjectContext reports the configured name with no worktree composite', () => {
      const ctx = getProjectContext(repoRoot);
      expect(ctx.primary).toBe('my-app');
      expect(ctx.parent).toBeNull();
      expect(ctx.isWorktree).toBe(false);
      expect(ctx.allProjects).toEqual(['my-app']);
    });

    it('also accepts the snake_case project_name key', async () => {
      const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-cfgsnake-')));
      writeFileSync(join(dir, '.claude-mem.json'), JSON.stringify({ project_name: 'Shared' }));
      expect(getProjectName(dir)).toBe('Shared');
      rmSync(dir, { recursive: true, force: true });
    });

    it('ignores an empty or non-string projectName and falls back to basename', async () => {
      const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import('fs');
      const { join, basename } = await import('path');
      const { tmpdir } = await import('os');
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-cfgempty-')));
      writeFileSync(join(dir, '.claude-mem.json'), JSON.stringify({ projectName: '   ' }));
      expect(getProjectName(dir)).toBe(basename(dir));
      rmSync(dir, { recursive: true, force: true });
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
    expect(ctx.allProjects).toEqual(['unknown-project']);
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

  describe('submodule parent context', () => {
    let tmp: string;
    let mainRepo: string;
    let submoduleCheckout: string;
    let submoduleNestedDir: string;
    let submoduleGitDir: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const { execFileSync } = await import('child_process');

      tmp = mkdtempSync(join(tmpdir(), 'cm-submodule-'));
      mainRepo = join(tmp, 'main-repo');
      submoduleCheckout = join(mainRepo, 'vendor', 'docs');
      submoduleNestedDir = join(submoduleCheckout, 'src', 'nested');
      submoduleGitDir = join(mainRepo, '.git', 'modules', 'vendor', 'docs');

      mkdirSync(mainRepo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: mainRepo });
      mkdirSync(submoduleGitDir, { recursive: true });
      mkdirSync(submoduleNestedDir, { recursive: true });
      writeFileSync(
        join(submoduleCheckout, '.git'),
        `gitdir: ${submoduleGitDir}\n`
      );
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('uses the parent repo as the primary project when in a submodule', () => {
      const ctx = getProjectContext(submoduleCheckout);
      expect(ctx.isWorktree).toBe(false);
      expect(ctx.primary).toBe('main-repo');
      expect(ctx.parent).toBeNull();
      expect(ctx.allProjects).toEqual(['main-repo']);
    });

    it('does not let the leaf submodule name displace parent context', () => {
      const ctx = getProjectContext(submoduleCheckout);
      expect(ctx.primary).not.toBe('docs');
      expect(ctx.allProjects).not.toContain('docs');
    });

    it('keeps the parent repo context when launched from a nested submodule directory', () => {
      const ctx = getProjectContext(submoduleNestedDir);
      expect(ctx.primary).toBe('main-repo');
      expect(ctx.parent).toBeNull();
      expect(ctx.allProjects).toEqual(['main-repo']);
    });

    it('resolves the default relative gitdir pointer before deriving the parent project', async () => {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');

      writeFileSync(
        join(submoduleCheckout, '.git'),
        'gitdir: ../../.git/modules/vendor/docs\n'
      );

      const ctx = getProjectContext(submoduleCheckout);
      expect(ctx.primary).toBe('main-repo');
      expect(ctx.parent).toBeNull();
      expect(ctx.allProjects).toEqual(['main-repo']);

      writeFileSync(
        join(submoduleCheckout, '.git'),
        `gitdir: ${submoduleGitDir}\n`
      );
    });
  });

  describe('ancestor worktree isolation', () => {
    let tmp: string;
    let homeRoot: string;
    let repoRoot: string;
    let nestedDir: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = mkdtempSync(join(tmpdir(), 'cm-home-worktree-'));
      homeRoot = join(tmp, 'home');
      repoRoot = join(homeRoot, 'projects', 'my-app');
      nestedDir = join(repoRoot, 'src');
      const dotfilesWorktreeGitDir = join(homeRoot, '.dotfiles.git', 'worktrees', 'main');

      mkdirSync(dotfilesWorktreeGitDir, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        join(homeRoot, '.git'),
        `gitdir: ${dotfilesWorktreeGitDir}\n`
      );
      execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('ignores unrelated ancestor worktrees when a real repo root is present below them', () => {
      const ctx = getProjectContext(nestedDir);
      expect(ctx.isWorktree).toBe(false);
      expect(ctx.primary).toBe('my-app');
      expect(ctx.parent).toBeNull();
      expect(ctx.allProjects).toEqual(['my-app']);
    });
  });
});
