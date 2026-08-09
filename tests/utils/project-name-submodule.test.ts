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
});

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

  it('leaves the superproject itself a plain top-level project', () => {
    const ctx = getProjectContext(superproject);
    expect(ctx.primary).toBe('react');
    expect(ctx.parent).toBeNull();
    expect(ctx.allProjects).toEqual(['react']);
  });
});
