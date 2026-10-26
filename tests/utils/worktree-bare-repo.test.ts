import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectWorktree } from '../../src/utils/worktree.js';
import { getPathModeProjectContext } from '../../src/utils/project-name.js';

// A worktree of a bare repository has a gitdir of `<repo>.git/worktrees/<name>`
// (or `<project>/.bare/worktrees/<name>`), with no `.git` directory in the path.
// It was not recognised as a worktree, so the worktrees named `main` of two
// different bare repositories shared the project key `main`.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('detectWorktree — worktrees of a bare repository', () => {
  let tmp: string;

  function makeBareRepo(bareDir: string): void {
    const seed = `${bareDir}-seed`;
    mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q');
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'Test');
    writeFileSync(join(seed, 'README'), 'init\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'init');
    git(tmp, 'clone', '-q', '--bare', seed, bareDir);
    rmSync(seed, { recursive: true, force: true });
  }

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cm-wt-bare-')));

    // `<repo>.git` bare clone, worktrees next to it.
    makeBareRepo(join(tmp, 'alpha.git'));
    git(join(tmp, 'alpha.git'), 'worktree', 'add', '-q', join(tmp, 'alpha-trees', 'main'));

    // `<project>/.bare` layout, worktrees inside the project folder.
    makeBareRepo(join(tmp, 'beta', '.bare'));
    git(join(tmp, 'beta', '.bare'), 'worktree', 'add', '-q', join(tmp, 'beta', 'main'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('names the parent after a `<repo>.git` bare repository', () => {
    const info = detectWorktree(join(tmp, 'alpha-trees', 'main'));
    expect(info.isWorktree).toBe(true);
    expect(info.isSubmodule).toBe(false);
    expect(info.worktreeName).toBe('main');
    expect(info.parentRepoPath).toBe(join(tmp, 'alpha.git'));
    expect(info.parentProjectName).toBe('alpha');
  });

  it('names the parent after the folder holding a hidden `.bare` repository', () => {
    const info = detectWorktree(join(tmp, 'beta', 'main'));
    expect(info.isWorktree).toBe(true);
    expect(info.parentRepoPath).toBe(join(tmp, 'beta', '.bare'));
    expect(info.parentProjectName).toBe('beta');
  });

  it('keeps same-named worktrees of different bare repositories apart', () => {
    const alpha = getPathModeProjectContext(join(tmp, 'alpha-trees', 'main'));
    const beta = getPathModeProjectContext(join(tmp, 'beta', 'main'));
    expect(alpha.primary).toBe('alpha/main');
    expect(beta.primary).toBe('beta/main');
    expect(alpha.isWorktree).toBe(true);
  });
});
