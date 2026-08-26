// #2842 / #2967: a session whose cwd is inside a git submodule resolved to the
// submodule's own leaf name — a brand-new, empty project — so context injection
// showed "This project has no memory yet" even though the superproject had a
// full history. detectWorktree() only matched `.git/worktrees/<name>` gitdir
// pointers; a submodule's `.git` file points at `.git/modules/<name>`, so it
// fell through to the standalone-project branch.
//
// A submodule folds into its superproject the same way a worktree does.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import { getProjectContext } from '../../src/utils/project-name.js';

let tempRoot: string;
let superproject: string;
let submodule: string;
let submoduleSubdir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
  });
}

function initRepo(repo: string, branch: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', branch);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-mem-2842-')));
  superproject = path.join(tempRoot, 'react');
  const child = path.join(tempRoot, 'peerless-origin');

  initRepo(superproject, 'main');
  initRepo(child, 'main');

  git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'peerless');
  git(superproject, 'commit', '-m', 'add submodule');

  submodule = path.join(superproject, 'peerless');
  submoduleSubdir = path.join(submodule, 'src', 'nested');
  mkdirSync(submoduleSubdir, { recursive: true });
});

afterAll(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  for (const root of nestedRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

function buildNestedFixture(): { outer: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-mem-2842-nested-')));
  const shared = path.join(root, 'shared-origin');
  const alpha = path.join(root, 'alpha-origin');
  const beta = path.join(root, 'beta-origin');
  const outer = path.join(root, 'outer');

  for (const repo of [shared, alpha, beta, outer]) initRepo(repo, 'main');

  for (const parent of [alpha, beta]) {
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', shared, 'shared');
    git(parent, 'commit', '-m', 'add shared');
  }
  git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', alpha, 'alpha');
  git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', beta, 'beta');
  git(outer, 'commit', '-m', 'add alpha+beta');
  git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');

  nestedRoots.push(root);
  return { outer };
}

const nestedRoots: string[] = [];

describe('#2842 — submodule folds into the superproject', () => {
  it('submodule root resolves to the superproject composite key', () => {
    const ctx = getProjectContext(submodule);
    expect(ctx.parent).toBe('react');
    expect(ctx.primary).toBe('react/peerless');
  });

  it('reads the superproject history alongside the submodule key', () => {
    const ctx = getProjectContext(submodule);
    expect(ctx.allProjects).toEqual(['react', 'react/peerless']);
  });

  it('does not claim a submodule is a worktree', () => {
    const ctx = getProjectContext(submodule);
    expect(ctx.isWorktree).toBe(false);
    expect(ctx.isSubmodule).toBe(true);
  });

  it('subdirectory of a submodule yields the same key as its root', () => {
    const atRoot = getProjectContext(submodule).primary;
    const inSubdir = getProjectContext(submoduleSubdir).primary;
    expect(inSubdir).toBe(atRoot);
    expect(inSubdir).not.toBe('peerless');
    expect(inSubdir).not.toBe('nested');
  });

  // Two nested submodules can share a leaf repo name under one superproject.
  // Keying on the superproject + leaf basename alone collapses them into one
  // project, so each checkout's observations would overwrite and read back as
  // the other's. The key has to carry the path that distinguishes them.
  it('keeps same-named nested submodules under distinct project keys', () => {
    const nested = buildNestedFixture();

    const alpha = getProjectContext(path.join(nested.outer, 'alpha', 'shared'));
    const beta = getProjectContext(path.join(nested.outer, 'beta', 'shared'));

    expect(alpha.primary).toBe('outer/alpha/shared');
    expect(beta.primary).toBe('outer/beta/shared');
    expect(alpha.primary).not.toBe(beta.primary);
    expect(alpha.parent).toBe('outer');
    expect(beta.parent).toBe('outer');
  });

  it('leaves the superproject itself a plain top-level project', () => {
    const ctx = getProjectContext(superproject);
    expect(ctx.primary).toBe('react');
    expect(ctx.parent).toBeNull();
    expect(ctx.allProjects).toEqual(['react']);
  });
});
