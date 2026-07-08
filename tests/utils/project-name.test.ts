
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { homedir } from 'os';
import path from 'path';
import { getProjectName, getProjectContext } from '../../src/utils/project-name.js';

describe('getProjectName', () => {
  describe('tilde expansion', () => {
    it('resolves bare ~ to home directory basename', () => {
      const home = homedir();
      const expected = path.basename(home);
      expect(getProjectName('~')).toBe(expected);
    });

    it('resolves ~/subpath to subpath', () => {
      expect(getProjectName('~/projects/my-app')).toBe('my-app');
    });

    it('resolves ~/ to home directory basename', () => {
      const home = homedir();
      const expected = path.basename(home);
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

    it('plain subdirectory inside a declared workspace repo yields a repo-relative project key', async () => {
      const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-workspace-')));
      try {
        const root = join(tmpDir, 'my-real-repo');
        const automationDir = join(root, 'automation', 'scripts');
        mkdirSync(automationDir, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-real-repo', workspaces: ['packages/*'] }));

        expect(getProjectName(automationDir)).toBe('my-real-repo/automation');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('plain subdirectory inside a non-workspace package repo stays on the repo-root key', async () => {
      const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-singlepkg-')));
      try {
        const root = join(tmpDir, 'my-real-repo');
        const srcDir = join(root, 'src', 'lib');
        mkdirSync(srcDir, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-real-repo' }));

        expect(getProjectName(srcDir)).toBe('my-real-repo');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('package directory inside a monorepo yields the repo-relative package key', async () => {
      const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-package-root-')));
      try {
        const root = join(tmpDir, 'my-real-repo');
        const packageSrcDir = join(root, 'packages', 'api', 'src');
        mkdirSync(packageSrcDir, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api' }));

        expect(getProjectName(packageSrcDir)).toBe('my-real-repo/packages/api');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('manifest-less monorepos split plain subdirectories when nested package roots exist', async () => {
      const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-manifestless-mono-')));
      try {
        const root = join(tmpDir, 'my-real-repo');
        const automationDir = join(root, 'automation', 'scripts');
        mkdirSync(automationDir, { recursive: true });
        mkdirSync(join(root, 'packages', 'api'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        writeFileSync(join(root, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api' }));

        expect(getProjectName(automationDir)).toBe('my-real-repo/automation');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
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
      expect(ctx.allProjects).toEqual(['my-app:dream', 'my-app']);
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
    expect(ctx.allProjects).toEqual(['my-project:dream', 'my-project']);
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
    expect(ctx.allProjects).toEqual(['unknown-project:dream', 'unknown-project']);
  });

  it('uses only the repo-relative subproject key for non-worktree monorepo paths', async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('fs');
    const { execFileSync } = await import('child_process');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-context-mono-')));
    try {
      const root = join(tmpDir, 'my-real-repo');
      const packageDir = join(root, 'packages', 'api', 'src');
      mkdirSync(packageDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-real-repo', workspaces: ['packages/*'] }));
      writeFileSync(join(root, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api' }));

      const ctx = getProjectContext(packageDir);
      expect(ctx.primary).toBe('my-real-repo/packages/api');
      expect(ctx.parent).toBeNull();
      expect(ctx.isWorktree).toBe(false);
      expect(ctx.allProjects).toEqual(['my-real-repo/packages/api:dream', 'my-real-repo/packages/api']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
      expect(ctx.allProjects).toEqual([
        'main-repo:dream',
        'main-repo/my-worktree:dream',
        'main-repo',
        'main-repo/my-worktree',
      ]);
    });

    it('write-path call sites resolve to composite name in worktrees', () => {
      const project = getProjectContext(worktreeCheckout).primary;
      expect(project).toBe('main-repo/my-worktree');
      expect(project).not.toBe('main-repo');
      expect(project).not.toBe('my-worktree');
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
      expect(ctx.allProjects).toEqual(['my-app:dream', 'my-app']);
    });
  });
});
