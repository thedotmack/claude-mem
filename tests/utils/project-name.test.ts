
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { homedir } from 'os';
import { getProjectName, getProjectContext, getDreamProjectName } from '../../src/utils/project-name.js';

function homeBasename(): string {
  return homedir().split(/[/\\]/).filter(Boolean).pop() ?? '';
}

describe('getProjectName', () => {
  describe('tilde expansion', () => {
    it('resolves bare ~ to home directory basename', () => {
      expect(getProjectName('~')).toBe(homeBasename());
    });

    it('resolves ~/subpath to subpath', () => {
      expect(getProjectName('~/projects/my-app')).toBe('my-app');
    });

    it('resolves ~/ to home directory basename', () => {
      expect(getProjectName('~/')).toBe(homeBasename());
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

    it('manifest-less monorepos still split plain subdirectories when nested package roots exist', () => {
      const { mkdirSync, rmSync, writeFileSync } = require('fs');
      const { join } = require('path');
      const automationDir = join(repoRoot, 'automation');
      const packageDir = join(repoRoot, 'packages', 'api');
      mkdirSync(automationDir, { recursive: true });
      mkdirSync(packageDir, { recursive: true });
      rmSync(join(repoRoot, 'package.json'), { force: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'api' }));
      expect(getProjectName(automationDir)).toBe('my-real-repo/automation');
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

  it('does not append :dream twice for already-dream project names', () => {
    expect(getDreamProjectName('already:dream')).toBe('already:dream');
  });
});

describe('getProjectContext', () => {
  it('returns primary project name for normal path', () => {
    const ctx = getProjectContext('/home/user/my-project');
    expect(ctx.primary).toBe('my-project');
    expect(ctx.parent).toBeNull();
    expect(ctx.isWorktree).toBe(false);
    expect(ctx.allProjects).toEqual([getDreamProjectName('my-project'), 'my-project']);
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
    expect(ctx.allProjects).toEqual([
      getDreamProjectName('unknown-project'),
      'unknown-project',
    ]);
  });

  it('returns dream-aware fallback context for undefined', () => {
    const ctx = getProjectContext(undefined);
    expect(ctx.primary).toBe('unknown-project');
    expect(ctx.parent).toBeNull();
    expect(ctx.allProjects).toEqual([
      getDreamProjectName('unknown-project'),
      'unknown-project',
    ]);
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
        getDreamProjectName('main-repo'),
        getDreamProjectName('main-repo/my-worktree'),
        'main-repo',
        'main-repo/my-worktree'
      ]);
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

describe('parseOriginUrlToSlug — CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote', () => {
  it('parses scp-style ssh URLs', () => {
    expect(parseOriginUrlToSlug('git@github.com:thedotmack/claude-mem.git')).toBe('thedotmack/claude-mem');
  });

  it('parses https URLs', () => {
    expect(parseOriginUrlToSlug('https://github.com/thedotmack/claude-mem.git')).toBe('thedotmack/claude-mem');
  });

  it('parses ssh:// URLs', () => {
    expect(parseOriginUrlToSlug('ssh://git@github.com/thedotmack/claude-mem.git')).toBe('thedotmack/claude-mem');
  });

  it('tolerates a missing .git suffix', () => {
    expect(parseOriginUrlToSlug('https://github.com/thedotmack/claude-mem')).toBe('thedotmack/claude-mem');
  });

  it('tolerates a trailing slash', () => {
    expect(parseOriginUrlToSlug('https://github.com/thedotmack/claude-mem/')).toBe('thedotmack/claude-mem');
  });

  it('takes the last two segments for nested groups (e.g. GitLab subgroups)', () => {
    expect(parseOriginUrlToSlug('https://gitlab.com/group/subgroup/repo.git')).toBe('subgroup/repo');
  });

  it('handles self-hosted hosts with ports (scp-style)', () => {
    expect(parseOriginUrlToSlug('git@frango:money-marathon/prolific.git')).toBe('money-marathon/prolific');
  });

  it('returns a single segment when that is all there is', () => {
    expect(parseOriginUrlToSlug('git@github.com:solorepo.git')).toBe('solorepo');
  });

  it('returns null for empty / blank input', () => {
    expect(parseOriginUrlToSlug('')).toBeNull();
    expect(parseOriginUrlToSlug('   ')).toBeNull();
  });
});
