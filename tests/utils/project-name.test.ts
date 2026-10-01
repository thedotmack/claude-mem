
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { basename } from 'path';
import { homedir } from 'os';
import { getProjectName, getProjectContext, getPathModeProjectContext, resolveHookProjectPath, buildWorktreeProjectKey, parseOriginUrlToSlug } from '../../src/utils/project-name.js';

const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
const ANCHORED_PROJECT_DIR_NAME = 'anchored-project';
const OTHER_PROJECT_DIR_NAME = 'other-project';
const SDK_TEMP_DIR_NAME = 'T';
const CLAUDE_PROJECT_TEMP_PREFIX = 'cm-claude-project-dir-';
const REPO_NESTED_DIR = ['packages', 'sdk-session'];
const GIT_INIT_ARGS = ['init', '-q'];
const savedClaudeProjectDir = process.env[CLAUDE_PROJECT_DIR_ENV];

beforeAll(() => {
  delete process.env[CLAUDE_PROJECT_DIR_ENV];
});

afterAll(() => {
  if (savedClaudeProjectDir !== undefined) {
    process.env[CLAUDE_PROJECT_DIR_ENV] = savedClaudeProjectDir;
  } else {
    delete process.env[CLAUDE_PROJECT_DIR_ENV];
  }
});

describe('getProjectName', () => {
  describe('tilde expansion', () => {
    it('resolves bare ~ to home directory basename', () => {
      expect(getProjectName('~')).toBe(basename(homedir()));
    });

    it('resolves ~/subpath to subpath', () => {
      // Do not use ~/projects/... : on Windows that case-folds onto a real
      // Projects directory and the #3194 marker walk will pick it up.
      expect(getProjectName('~/cm-3194-nosuch/my-app')).toBe('my-app');
    });

    it('resolves ~/ to home directory basename', () => {
      expect(getProjectName('~/')).toBe(basename(homedir()));
    });

    it('resolves a leading ~\\ on Windows', () => {
      expect(getProjectName('~\\windows-project', 'win32')).toBe('windows-project');
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

    it('returns unknown-project for the filesystem root', () => {
      expect(getProjectName('/')).toBe('unknown-project');
    });

    it('keeps the hook cwd when CLAUDE_PROJECT_DIR is unavailable', () => {
      expect(resolveHookProjectPath(SDK_TEMP_DIR_NAME)).toBe(SDK_TEMP_DIR_NAME);
    });

    it('returns null when hook cwd and CLAUDE_PROJECT_DIR are unavailable', () => {
      expect(resolveHookProjectPath(null)).toBeNull();
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

  describe('#3194 — an explicit claude-mem marker names a non-git project', () => {
    let tmp: string;
    let markedParent: string;
    let markedSub: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      // Isolate under a unique temp root so upward marker walks stay inside it.
      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-3194-')));
      markedParent = join(tmp, 'home-project');
      markedSub = join(markedParent, 'automation');
      mkdirSync(markedSub, { recursive: true });
      writeFileSync(join(markedParent, '.claude-mem-project'), '');
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('a subdir under a .claude-mem-project root resolves to the root basename', () => {
      expect(getProjectName(markedSub)).toBe('home-project');
      expect(getProjectName(markedParent)).toBe('home-project');
    });

    it('writes use the marker key; the pre-marker key stays readable as an alias', () => {
      const sub = getProjectContext(markedSub);
      expect(sub.primary).toBe('home-project');
      // Sessions launched from `automation` before the marker existed were
      // stored under `automation`; adding a marker must not hide them.
      expect(sub.allProjects).toEqual(['automation', 'home-project']);
      expect(sub.parent).toBeNull();

      expect(getProjectContext(markedParent).allProjects).toEqual(['home-project']);
    });

    it('accepts the existing .claude-mem.json project file as a marker', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const app = join(tmp, 'projects', 'json-app');
      const nested = join(app, 'src');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(app, '.claude-mem.json'), '{}\n');
      expect(getProjectName(nested)).toBe('json-app');
    });

    it('ignores generic manifests, so existing keys do not move', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const app = join(tmp, 'projects', 'my-app');
      const nested = join(app, 'src');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{"name":"my-app"}\n');
      writeFileSync(join(app, 'CLAUDE.md'), '# my app\n');
      expect(getProjectName(nested)).toBe('src');
      expect(getProjectContext(nested).allProjects).toEqual(['src']);
    });

    it('a marker-less non-git dir keeps basename(cwd) and never widens to its parent', () => {
      expect(getProjectName('/no/such/lc/bin')).toBe('bin');
      const ctx = getProjectContext('/no/such/lc/bin');
      expect(ctx.primary).toBe('bin');
      expect(ctx.allProjects).toEqual(['bin']);
      expect(ctx.parent).toBeNull();
    });

    it('uses resolveHookProjectPath then marker walk for a non-git CLAUDE_PROJECT_DIR', () => {
      process.env[CLAUDE_PROJECT_DIR_ENV] = markedParent;
      try {
        const hookPath = resolveHookProjectPath(SDK_TEMP_DIR_NAME);
        expect(hookPath).toBe(markedParent);
        expect(getProjectName(hookPath)).toBe('home-project');
        expect(getProjectContext(hookPath).primary).toBe('home-project');
      } finally {
        delete process.env[CLAUDE_PROJECT_DIR_ENV];
      }
    });

    // os.homedir() is fixed for the life of a Bun process, so the stop
    // directories are exercised in a child with its own HOME / TMPDIR /
    // CLAUDE_CONFIG_DIR.
    function resolveInChild(cwd: string, env: Record<string, string>): { name: string; allProjects: string[] } {
      const { join } = require('path') as typeof import('path');
      const modulePath = join(import.meta.dir, '../../src/utils/project-name.ts');
      const script = `
        const { getProjectName, getProjectContext } = await import(${JSON.stringify(modulePath)});
        const cwd = ${JSON.stringify(cwd)};
        console.log(JSON.stringify({ name: getProjectName(cwd), allProjects: getProjectContext(cwd).allProjects }));
      `;
      const result = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, ...env } });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      const lines = new TextDecoder().decode(result.stdout).trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    }

    it('never treats the home directory as a marker root', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const fakeHome = join(tmp, 'fake-home');
      const notes = join(fakeHome, 'notes');
      mkdirSync(notes, { recursive: true });
      // A ~/.claude-mem.json would otherwise fold every non-git directory under
      // $HOME into one bucket named after the user.
      writeFileSync(join(fakeHome, '.claude-mem.json'), '{}\n');
      writeFileSync(join(fakeHome, '.claude-mem-project'), '');

      const resolved = resolveInChild(notes, { HOME: fakeHome, CLAUDE_CONFIG_DIR: join(fakeHome, '.claude') });
      expect(resolved).toEqual({ name: 'notes', allProjects: ['notes'] });
    });

    it('never treats TMPDIR or Claude\'s config dir as marker roots', async () => {
      const { mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const fakeTmp = join(tmp, 'fake-tmp');
      const scratch = join(fakeTmp, 'scratch');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(fakeTmp, '.claude-mem-project'), '');

      const fakeConfig = join(tmp, 'fake-config');
      const pluginDir = join(fakeConfig, 'plugins', 'cache', 'thedotmack', 'claude-mem', '13.0.0');
      mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
      writeFileSync(join(pluginDir, '.claude-mem.json'), '{}\n');

      const env = { TMPDIR: fakeTmp, CLAUDE_CONFIG_DIR: fakeConfig };
      expect(resolveInChild(scratch, env)).toEqual({ name: 'scratch', allProjects: ['scratch'] });
      expect(resolveInChild(join(pluginDir, 'scripts'), env)).toEqual({ name: 'scripts', allProjects: ['scripts'] });
    });
  });

  describe('#3437 — Claude project dir anchors SDK/subagent sessions', () => {
    let tmp: string;
    let repoRoot: string;
    let nestedRepoDir: string;
    let otherProjectDir: string;
    let sdkTempDir: string;
    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, realpathSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = realpathSync(mkdtempSync(join(tmpdir(), CLAUDE_PROJECT_TEMP_PREFIX)));
      repoRoot = join(tmp, ANCHORED_PROJECT_DIR_NAME);
      nestedRepoDir = join(repoRoot, ...REPO_NESTED_DIR);
      otherProjectDir = join(tmp, OTHER_PROJECT_DIR_NAME);
      sdkTempDir = join(tmp, SDK_TEMP_DIR_NAME);
      mkdirSync(nestedRepoDir, { recursive: true });
      mkdirSync(otherProjectDir, { recursive: true });
      mkdirSync(sdkTempDir, { recursive: true });
      execFileSync('git', GIT_INIT_ARGS, { cwd: repoRoot });
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');

      delete process.env[CLAUDE_PROJECT_DIR_ENV];
      rmSync(tmp, { recursive: true, force: true });
    });

    it('uses CLAUDE_PROJECT_DIR instead of an SDK temp cwd', () => {
      process.env[CLAUDE_PROJECT_DIR_ENV] = repoRoot;

      const hookProjectPath = resolveHookProjectPath(sdkTempDir);
      expect(getProjectName(hookProjectPath)).toBe(ANCHORED_PROJECT_DIR_NAME);
      expect(getProjectName(hookProjectPath)).not.toBe(SDK_TEMP_DIR_NAME);
    });

    it('resolves CLAUDE_PROJECT_DIR through its git root when it points at a subdirectory', () => {
      process.env[CLAUDE_PROJECT_DIR_ENV] = nestedRepoDir;

      expect(getProjectName(resolveHookProjectPath(sdkTempDir))).toBe(ANCHORED_PROJECT_DIR_NAME);
    });

    it('anchors getProjectContext to CLAUDE_PROJECT_DIR for write-path callers', () => {
      process.env[CLAUDE_PROJECT_DIR_ENV] = repoRoot;

      const ctx = getProjectContext(resolveHookProjectPath(sdkTempDir));
      expect(ctx.primary).toBe(ANCHORED_PROJECT_DIR_NAME);
      expect(ctx.allProjects).toEqual([ANCHORED_PROJECT_DIR_NAME]);
    });

    it('keeps an explicit project cwd authoritative outside hook normalization', () => {
      process.env[CLAUDE_PROJECT_DIR_ENV] = repoRoot;

      expect(getProjectName(otherProjectDir)).toBe(OTHER_PROJECT_DIR_NAME);
      expect(getProjectContext(otherProjectDir).primary).toBe(OTHER_PROJECT_DIR_NAME);
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

  // #3641 — Codex CLI puts worktrees at ~/.codex/worktrees/<id>/<repo>, so the
  // worktree basename equals the repo name and the naive compound key doubles
  // to <repo>/<repo>. That doubled key matches neither injection nor search.
  describe('#3641 — doubled worktree key collapses to the repo name', () => {
    let tmp: string;
    let doubledCheckout: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = mkdtempSync(join(tmpdir(), 'cm-wt-doubled-'));
      // Mirror the Codex layout: the worktree checkout basename equals the
      // parent repo basename (both 'q-companies-master').
      const mainRepo = join(tmp, 'q-companies-master');
      const worktreeGitDir = join(mainRepo, '.git', 'worktrees', 'q-companies-master');
      doubledCheckout = join(tmp, 'codex-6389', 'q-companies-master');

      mkdirSync(worktreeGitDir, { recursive: true });
      mkdirSync(doubledCheckout, { recursive: true });
      writeFileSync(join(doubledCheckout, '.git'), `gitdir: ${worktreeGitDir}\n`);
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      rmSync(tmp, { recursive: true, force: true });
    });

    it('buildWorktreeProjectKey collapses when worktree name equals parent', () => {
      expect(buildWorktreeProjectKey('q-companies-master', 'q-companies-master')).toBe('q-companies-master');
    });

    it('buildWorktreeProjectKey keeps the compound key when names differ', () => {
      expect(buildWorktreeProjectKey('main-repo', 'feature-x')).toBe('main-repo/feature-x');
    });

    it('getProjectContext collapses the doubled key to the parent name', () => {
      const ctx = getProjectContext(doubledCheckout);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('q-companies-master');
      expect(ctx.parent).toBe('q-companies-master');
      // Rows written before the collapse are stored under the doubled key; it
      // stays readable until the adoption sweep folds them into the repo.
      expect(ctx.allProjects).toEqual(['q-companies-master/q-companies-master', 'q-companies-master']);
    });
  });

  // #3262 — detectWorktree must run at the git worktree root, not raw cwd.
  // A session started in a subdirectory of a worktree must keep the same
  // parent/worktree compound key as a session at the worktree root.
  describe('#3262 — worktree compound key from subdirectory', () => {
    let tmp: string;
    let worktreeCheckout: string;
    let worktreeSubdir: string;

    beforeAll(async () => {
      const { mkdtempSync, mkdirSync, realpathSync, writeFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      const { tmpdir } = await import('os');

      tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-wt-subdir-')));
      const mainRepo = join(tmp, 'main-repo');
      worktreeCheckout = join(tmp, 'feature-x');
      worktreeSubdir = join(worktreeCheckout, 'packages', 'nested');

      mkdirSync(mainRepo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
      writeFileSync(join(mainRepo, 'README'), 'init\n');
      execFileSync('git', ['add', '.'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: mainRepo });
      execFileSync('git', ['worktree', 'add', '-q', worktreeCheckout, '-b', 'feature-x'], {
        cwd: mainRepo,
      });
      mkdirSync(worktreeSubdir, { recursive: true });
    });

    afterAll(async () => {
      const { rmSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      const { join } = await import('path');
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreeCheckout], {
          cwd: join(tmp, 'main-repo'),
        });
      } catch {
        // Best-effort cleanup; rmSync below still removes the temp tree.
      }
      rmSync(tmp, { recursive: true, force: true });
    });

    it('worktree root yields parent/worktree composite', () => {
      const ctx = getProjectContext(worktreeCheckout);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('main-repo/feature-x');
      expect(ctx.parent).toBe('main-repo');
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/feature-x']);
    });

    it('subdirectory of a worktree yields the same composite key', () => {
      const ctx = getProjectContext(worktreeSubdir);
      expect(ctx.isWorktree).toBe(true);
      expect(ctx.primary).toBe('main-repo/feature-x');
      expect(ctx.parent).toBe('main-repo');
      expect(ctx.allProjects).toEqual(['main-repo', 'main-repo/feature-x']);
    });

    it('subdirectory and worktree root share the same primary key', () => {
      const atRoot = getProjectContext(worktreeCheckout).primary;
      const inSubdir = getProjectContext(worktreeSubdir).primary;
      expect(inSubdir).toBe(atRoot);
      expect(inSubdir).not.toBe('feature-x');
      expect(inSubdir).not.toBe('nested');
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

  it('strips the trailing slash before .git, so repo.git/ loses both', () => {
    expect(parseOriginUrlToSlug('https://github.com/acme/widgets.git/')).toBe('acme/widgets');
  });

  it('takes the last two segments for nested groups (e.g. GitLab subgroups)', () => {
    expect(parseOriginUrlToSlug('https://gitlab.com/group/subgroup/repo.git')).toBe('subgroup/repo');
  });

  it('handles self-hosted hosts, ports and the user-less scp form', () => {
    expect(parseOriginUrlToSlug('git@frango:money-marathon/prolific.git')).toBe('money-marathon/prolific');
    expect(parseOriginUrlToSlug('https://code.example.com:8443/acme/widgets.git')).toBe('acme/widgets');
    expect(parseOriginUrlToSlug('code.example.com:acme/widgets')).toBe('acme/widgets');
  });

  // Gate P2-16: Azure DevOps puts `_git` between the project and the
  // repository; it names the URL scheme, not the repository.
  it('skips the _git segment of Azure DevOps URLs', () => {
    expect(parseOriginUrlToSlug('https://dev.azure.com/contoso/payments/_git/api')).toBe('payments/api');
    expect(parseOriginUrlToSlug('https://contoso@dev.azure.com/contoso/payments/_git/api')).toBe('payments/api');
    expect(parseOriginUrlToSlug('https://contoso.visualstudio.com/DefaultCollection/payments/_git/api')).toBe('payments/api');
    expect(parseOriginUrlToSlug('git@ssh.dev.azure.com:v3/contoso/payments/api')).toBe('payments/api');
  });

  it('returns a single segment when that is all there is', () => {
    expect(parseOriginUrlToSlug('git@github.com:solorepo.git')).toBe('solorepo');
  });

  it('rejects local remotes, which name a directory on this machine', () => {
    expect(parseOriginUrlToSlug('file:///srv/repos/widgets.git')).toBeNull();
    expect(parseOriginUrlToSlug('/srv/repos/widgets.git')).toBeNull();
    expect(parseOriginUrlToSlug('../widgets')).toBeNull();
    expect(parseOriginUrlToSlug('C:\\repos\\widgets')).toBeNull();
  });

  it('rejects bare hosts and empty input', () => {
    expect(parseOriginUrlToSlug('https://github.com')).toBeNull();
    expect(parseOriginUrlToSlug('https://github.com/')).toBeNull();
    expect(parseOriginUrlToSlug('git@github.com:')).toBeNull();
    expect(parseOriginUrlToSlug('')).toBeNull();
    expect(parseOriginUrlToSlug('   ')).toBeNull();
  });
});

describe('#2827 — git-remote project names', () => {
  const SOURCE_ENV = 'CLAUDE_MEM_PROJECT_NAME_SOURCE';
  const savedSource = process.env[SOURCE_ENV];
  let tmp: string;
  let repo: string;
  let worktree: string;
  let noRemoteRepo: string;
  let noRemoteWorktree: string;
  let sameNameRepo: string;
  let sameNameCodexWorktree: string;

  beforeAll(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import('fs');
    const { execFileSync } = await import('child_process');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    const initRepo = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      run(dir, 'init', '-q', '-b', 'main');
      run(dir, 'config', 'user.email', 'test@example.com');
      run(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      run(dir, 'add', 'README.md');
      run(dir, 'commit', '-q', '-m', 'base');
    };

    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-2827-')));
    repo = join(tmp, 'widgets-checkout');
    worktree = join(tmp, 'widgets-feature');
    noRemoteRepo = join(tmp, 'scratchpad');
    noRemoteWorktree = join(tmp, 'scratchpad-wt');

    initRepo(repo);
    run(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    run(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);

    initRepo(noRemoteRepo);
    run(noRemoteRepo, 'worktree', 'add', '-q', '-b', 'wt', noRemoteWorktree);

    // org == repo (prettier/prettier), plus a Codex-style worktree named after it.
    sameNameRepo = join(tmp, 'prettier');
    sameNameCodexWorktree = join(tmp, 'codex', 'c1', 'prettier');
    initRepo(sameNameRepo);
    run(sameNameRepo, 'remote', 'add', 'origin', 'https://github.com/prettier/prettier.git');
    mkdirSync(join(tmp, 'codex', 'c1'), { recursive: true });
    run(sameNameRepo, 'worktree', 'add', '-q', '-b', 'codex-task', sameNameCodexWorktree);

    process.env[SOURCE_ENV] = 'git-remote';
  }, 30_000);

  afterAll(async () => {
    const { rmSync } = await import('fs');
    if (savedSource === undefined) delete process.env[SOURCE_ENV];
    else process.env[SOURCE_ENV] = savedSource;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('names the repository by its origin slug and keeps the folder key readable', () => {
    expect(getProjectName(repo)).toBe('acme/widgets');
    const ctx = getProjectContext(repo);
    expect(ctx.primary).toBe('acme/widgets');
    // Memory stored under the folder name before the switch stays reachable.
    expect(ctx.allProjects).toEqual(['widgets-checkout', 'acme/widgets']);
  });

  it('folds a worktree into the repository slug, keeping its old composite keys readable', () => {
    const ctx = getProjectContext(worktree);
    expect(ctx.primary).toBe('acme/widgets');
    expect(ctx.parent).toBeNull();
    expect(ctx.isWorktree).toBe(true);
    expect(ctx.allProjects).toEqual(['widgets-checkout', 'widgets-checkout/widgets-feature', 'acme/widgets']);
  });

  // Gate P1-2: worktree adoption only trusts a deleted checkout for a
  // folder-derived key, so every context says how its key was derived.
  it('reports how each key was derived', () => {
    expect(getProjectContext(repo).keySource).toBe('git-remote');
    expect(getProjectContext(worktree).keySource).toBe('git-remote');
    expect(getProjectContext(noRemoteWorktree).keySource).toBe('path');
    expect(getPathModeProjectContext(repo).keySource).toBe('path');
  });

  it('still exposes the folder-based identity that worktree adoption works on', () => {
    expect(getPathModeProjectContext(repo).primary).toBe('widgets-checkout');
    const ctx = getPathModeProjectContext(worktree);
    expect(ctx.primary).toBe('widgets-checkout/widgets-feature');
    expect(ctx.parent).toBe('widgets-checkout');
  });

  it('falls back to path mode, worktree compositing included, when no slug can be derived', () => {
    expect(getProjectName(noRemoteRepo)).toBe('scratchpad');
    const ctx = getProjectContext(noRemoteWorktree);
    expect(ctx.primary).toBe('scratchpad/scratchpad-wt');
    expect(ctx.allProjects).toEqual(['scratchpad', 'scratchpad/scratchpad-wt']);
  });

  // #3641's collapse (`<repo>/<repo>` → `<repo>`) is a path-mode rule: a slug
  // whose org and repository share a name is a real identity and stays whole.
  it('never collapses a slug whose org and repository share a name', () => {
    expect(getProjectName(sameNameRepo)).toBe('prettier/prettier');
    expect(getProjectContext(sameNameRepo).primary).toBe('prettier/prettier');
    const ctx = getProjectContext(sameNameCodexWorktree);
    expect(ctx.primary).toBe('prettier/prettier');
    expect(ctx.allProjects).toEqual(['prettier', 'prettier/prettier']);
  });
});
