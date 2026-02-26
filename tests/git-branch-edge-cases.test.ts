/**
 * Tests for git-branch.ts edge case handling
 *
 * Validates:
 * - isGitRepository: correctly identifies git vs non-git directories
 * - detectCurrentBranch: handles normal repos, detached HEAD, and non-git directories
 * - Worktree compatibility: git commands work in worktrees (same object store)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isGitRepository, detectCurrentBranch } from '../src/services/integrations/git-branch.js';

// Resolve repo root dynamically
const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

describe('isGitRepository', () => {
  it('should return true for a git repository', async () => {
    const result = await isGitRepository(REPO_ROOT);
    expect(result).toBe(true);
  });

  it('should return false for a non-git directory', async () => {
    const result = await isGitRepository('/tmp');
    expect(result).toBe(false);
  });

  it('should return false for a nonexistent directory', async () => {
    const result = await isGitRepository('/nonexistent/path/that/does/not/exist');
    expect(result).toBe(false);
  });
});

describe('detectCurrentBranch', () => {
  it('should return branch and commitSha for a normal git repo', async () => {
    const info = await detectCurrentBranch(REPO_ROOT);
    expect(info.commitSha).not.toBeNull();
    expect(info.commitSha!.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(info.commitSha!)).toBe(true);
    // Branch may be null if detached, but should be a string in normal usage
    if (info.branch !== null) {
      expect(typeof info.branch).toBe('string');
      expect(info.branch.length).toBeGreaterThan(0);
    }
  });

  it('should return null branch and null commitSha for a non-git directory', async () => {
    const info = await detectCurrentBranch('/tmp');
    expect(info.branch).toBeNull();
    expect(info.commitSha).toBeNull();
  });

  it('should return null branch and null commitSha for a nonexistent directory', async () => {
    const info = await detectCurrentBranch('/nonexistent/path');
    expect(info.branch).toBeNull();
    expect(info.commitSha).toBeNull();
  });
});

describe('detectCurrentBranch - detached HEAD', () => {
  let tempDir: string;

  beforeAll(() => {
    // Create a temporary git repo with a detached HEAD
    tempDir = mkdtempSync(join(tmpdir(), 'git-branch-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    execSync('echo "file1" > test.txt', { cwd: tempDir, stdio: 'pipe' });
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });
    // Create a second commit so we can detach to the first
    execSync('echo "file2" >> test.txt', { cwd: tempDir, stdio: 'pipe' });
    execSync('git add .', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "second"', { cwd: tempDir, stdio: 'pipe' });
    // Detach HEAD to first commit
    const firstCommit = execSync('git rev-parse HEAD~1', { cwd: tempDir, encoding: 'utf8' }).trim();
    execSync(`git checkout ${firstCommit}`, { cwd: tempDir, stdio: 'pipe' });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return null branch but valid commitSha in detached HEAD state', async () => {
    const info = await detectCurrentBranch(tempDir);
    expect(info.branch).toBeNull();
    expect(info.commitSha).not.toBeNull();
    expect(info.commitSha!.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(info.commitSha!)).toBe(true);
  });
});

describe('git worktree compatibility', () => {
  let worktreeDir: string;
  let createdWorktree = false;

  beforeAll(() => {
    // Create a git worktree to verify commands work in it
    try {
      worktreeDir = join(REPO_ROOT, '.claude', 'worktrees', 'test-branch-edge-cases');
      // Create a new branch for the worktree
      execSync(`git worktree add "${worktreeDir}" -b test-branch-edge-cases-temp HEAD`, {
        cwd: REPO_ROOT,
        stdio: 'pipe'
      });
      createdWorktree = true;
    } catch {
      // Worktree may already exist or fail for other reasons — skip test
      createdWorktree = false;
    }
  });

  afterAll(() => {
    if (createdWorktree) {
      try {
        execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: REPO_ROOT, stdio: 'pipe' });
        execSync('git branch -D test-branch-edge-cases-temp', { cwd: REPO_ROOT, stdio: 'pipe' });
      } catch { /* cleanup best-effort */ }
    }
  });

  it('isGitRepository should return true inside a worktree', async () => {
    if (!createdWorktree) return; // skip if worktree creation failed
    const result = await isGitRepository(worktreeDir);
    expect(result).toBe(true);
  });

  it('detectCurrentBranch should return valid info inside a worktree', async () => {
    if (!createdWorktree) return; // skip if worktree creation failed
    const info = await detectCurrentBranch(worktreeDir);
    expect(info.branch).toBe('test-branch-edge-cases-temp');
    expect(info.commitSha).not.toBeNull();
    expect(info.commitSha!.length).toBe(40);
  });
});
