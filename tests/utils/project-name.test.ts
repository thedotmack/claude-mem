
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

  describe('#2663 / #2882 — repo-relative keys inside repositories', () => {
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

    it('deep subdirectory without package.json stays on the repo-root key when the repo is not a declared workspace', () => {
      const { rmSync } = require('fs');
      const { join } = require('path');
      rmSync(join(repoRoot, 'package.json'), { force: true });
      expect(getProjectName(nestedDir)).toBe('my-real-repo');
    });

    it('repo root itself yields the repo-root name', () => {
      expect(getProjectName(repoRoot)).toBe('my-real-repo');
    });

    it('plain subdirectory inside a declared workspace repo yields a repo-relative project key', () => {
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const automationDir = join(repoRoot, 'automation');
      mkdirSync(automationDir, { recursive: true });
      writeFileSync(
        join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'my-real-repo', workspaces: ['packages/*'] })
      );
      expect(getProjectName(automationDir)).toBe('my-real-repo/automation');
    });

    it('plain subdirectories inside a single-package repo stay on the repo-root key', () => {
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const srcDir = join(repoRoot, 'src', 'routes');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'my-real-repo' }));
      expect(getProjectName(srcDir)).toBe('my-real-repo');
    });

    it('nested paths inside a plain subdirectory only split in declared workspace repos', () => {
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const scriptsDir = join(repoRoot, 'automation', 'scripts', 'build');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(
        join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'my-real-repo', workspaces: ['packages/*'] })
      );
      expect(getProjectName(scriptsDir)).toBe('my-real-repo/automation');
    });

    it('workspace roots still split plain subdirectories to repo-relative keys', () => {
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const automationDir = join(repoRoot, 'workspace-automation');
      mkdirSync(automationDir, { recursive: true });
      writeFileSync(
        join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'my-real-repo', workspaces: ['packages/*'] })
      );
      expect(getProjectName(automationDir)).toBe('my-real-repo/workspace-automation');
    });

    it('non-Node repos without a root manifest keep the repo-root key', () => {
      const { mkdirSync, rmSync } = require('fs');
      const { join } = require('path');
      const serviceDir = join(repoRoot, 'cmd', 'server');
      mkdirSync(serviceDir, { recursive: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });
      expect(getProjectName(serviceDir)).toBe('my-real-repo');
    });

    it('package directory inside a monorepo yields the repo-relative package key', () => {
      const { mkdirSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const packageDir = join(repoRoot, 'packages', 'api');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'api' }));
      expect(getProjectName(packageDir)).toBe('my-real-repo/packages/api');
    });

    it('subdirectory inside a monorepo package shares the repo-relative package key', () => {
      const { mkdirSync } = require('fs');
      const { join } = require('path');
      // api/package.json was created by the previous test; src/ has none
      const packageSrcDir = join(repoRoot, 'packages', 'api', 'src');
      mkdirSync(packageSrcDir, { recursive: true });
      expect(getProjectName(packageSrcDir)).toBe('my-real-repo/packages/api');
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

  it('uses only the repo-relative subproject key for non-worktree monorepo paths', async () => {
    const { mkdtempSync, mkdirSync, realpathSync, writeFileSync } = await import('fs');
    const { execFileSync } = await import('child_process');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-project-context-')));
    const repoRoot = join(tmp, 'my-real-repo');
    const packageDir = join(repoRoot, 'packages', 'api');
    const packageSrcDir = join(packageDir, 'src');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(packageSrcDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'api' }));

    try {
      const ctx = getProjectContext(packageSrcDir);
      expect(ctx.primary).toBe('my-real-repo/packages/api');
      expect(ctx.parent).toBeNull();
      expect(ctx.isWorktree).toBe(false);
      expect(ctx.allProjects).toEqual(['my-real-repo/packages/api']);
    } finally {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
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
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/my-worktree']);
    });

    it('write-path call sites resolve to composite name in worktrees', () => {
      const project = getProjectContext(worktreeCheckout).primary;
      expect(project).toBe('main-repo/my-worktree');
      expect(project).not.toBe('main-repo');
      expect(project).not.toBe('my-worktree');
    });

    it('subdirectories inside a worktree keep the same parent/worktree composite', async () => {
      const { mkdirSync } = await import('fs');
      const { join } = await import('path');
      const nestedDir = join(worktreeCheckout, 'src', 'routes');
      mkdirSync(nestedDir, { recursive: true });

      const ctx = getProjectContext(nestedDir);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('main-repo/my-worktree');
      expect(ctx.parent).toBe('main-repo');
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/my-worktree']);
    });
  });
});
