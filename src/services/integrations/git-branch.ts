/**
 * Git branch detection utility for branch memory feature.
 * Detects the current git branch and commit SHA for a given working directory.
 *
 * Critical: This runs inside hooks where stderr is suppressed and errors
 * must never crash the process. All failures return null values.
 */

import { execSync } from 'child_process';

export interface BranchInfo {
  branch: string | null;
  commitSha: string | null;
}

/**
 * Check whether the given directory is inside a git work tree.
 * Returns false for non-git directories, bare repos, and when git is not installed.
 */
export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Detect the current git branch and commit SHA for a working directory.
 *
 * Returns { branch: null, commitSha: null } on any failure (no git repo,
 * git not installed, detached HEAD for branch, etc.).
 *
 * Handles detached HEAD: branch is set to null but commitSha is still captured.
 */
export async function detectCurrentBranch(cwd: string): Promise<BranchInfo> {
  try {
    // Get branch name
    const rawBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],  // suppress stderr
      timeout: 5000
    }).trim();

    // Detached HEAD returns literal "HEAD"
    const branch = rawBranch === 'HEAD' ? null : (rawBranch || null);

    // Get commit SHA
    const commitSha = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim() || null;

    return { branch, commitSha };
  } catch {
    return { branch: null, commitSha: null };
  }
}
