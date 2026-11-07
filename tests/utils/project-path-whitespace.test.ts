import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPathModeProjectContext, getProjectName, resolveHookProjectPath } from '../../src/utils/project-name.js';
import { detectWorktree } from '../../src/utils/worktree.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-project-whitespace-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
function init(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
  return repo;
}

// These POSIX fixtures include path components Windows disallows. Use real Git
// repositories, not synthetic pointers: Git's output terminator is not path data.
const filesystemDescribe = process.platform === 'win32' ? describe.skip : describe;
filesystemDescribe('project identity preserves whitespace in Git paths', () => {
  for (const name of ['trailing-space ', 'trailing-tab\t', 'trailing-newline\n']) {
    it(`keeps the complete root name ${JSON.stringify(name)} from a nested cwd`, () => {
      const repo = init(name);
      const nested = join(repo, 'src', 'nested');
      mkdirSync(nested, { recursive: true });
      expect(getProjectName(nested)).toBe(name);
      expect(getPathModeProjectContext(nested).primary).toBe(name);
      const previous = process.env.CLAUDE_PROJECT_DIR;
      try {
        process.env.CLAUDE_PROJECT_DIR = repo;
        const hookPath = resolveHookProjectPath('/unrelated/subagent');
        expect(hookPath).toBe(repo);
        expect(getPathModeProjectContext(hookPath!).primary).toBe(name);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = previous;
      }
    });
  }

  for (const name of ['parent\nnotes', 'parent\rnotes', 'parent\u2028notes']) {
    it(`retains the parent for a linked checkout under ${JSON.stringify(name)}`, () => {
      const repo = init(name);
      const checkout = join(root, `${name}-trees`, 'topic');
      git(repo, 'worktree', 'add', '-q', '-b', 'topic', checkout);
      const nested = join(checkout, 'src');
      mkdirSync(nested);
      expect(detectWorktree(checkout).parentRepoPath).toBe(repo);
      expect(getPathModeProjectContext(nested).primary).toBe(`${name}/topic`);
    });
  }

  it('retains a bare repository parent containing a newline', () => {
    const seed = init('bare-seed');
    const bare = join(root, 'bare\nparent.git');
    git(root, 'clone', '-q', '--bare', seed, bare);
    const checkout = join(root, 'bare-checkouts', 'topic');
    git(bare, 'worktree', 'add', '-q', '-b', 'topic', checkout);
    expect(detectWorktree(checkout).parentRepoPath).toBe(bare);
    expect(getPathModeProjectContext(checkout).primary).toBe('bare\nparent/topic');
  });

  it('retains a submodule parent containing a newline', () => {
    const repo = init('super\nparent');
    const origin = init('submodule-source');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'child');
    const checkout = join(repo, 'child');
    expect(detectWorktree(checkout).isSubmodule).toBe(true);
    expect(detectWorktree(checkout).parentRepoPath).toBe(repo);
    expect(getPathModeProjectContext(checkout).primary).toBe('super\nparent/child');
  });

  it('keeps worktrees with trailing whitespace distinct from plain-named siblings', () => {
    const repo = init('worktree-parent');
    for (const [index, name] of ['topic', 'topic ', 'topic\n'].entries()) {
      const checkout = join(root, 'checkouts', name);
      git(repo, 'worktree', 'add', '-q', '-b', `branch-${index}`, checkout);
      expect(getPathModeProjectContext(checkout).primary).toBe(`worktree-parent/${name}`);
    }
  });
});

describe('hook project path whitespace', () => {
  it('preserves nonblank declared paths while treating blank declarations as absent', () => {
    const previous = process.env.CLAUDE_PROJECT_DIR;
    try {
      for (const declared of ['/workspace/project ', ' relative-project ', '/workspace/project\t', '/workspace/project\n']) {
        process.env.CLAUDE_PROJECT_DIR = declared;
        expect(resolveHookProjectPath('/subagent')).toBe(declared);
      }
      for (const blank of ['', ' ', '\t\n']) {
        process.env.CLAUDE_PROJECT_DIR = blank;
        expect(resolveHookProjectPath('/fallback ')).toBe('/fallback ');
        expect(resolveHookProjectPath(null)).toBeNull();
      }
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(resolveHookProjectPath('/fallback ')).toBe('/fallback ');
      expect(resolveHookProjectPath(null)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    }
  });
});
