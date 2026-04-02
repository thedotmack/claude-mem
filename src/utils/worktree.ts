/**
 * Worktree Detection Utility
 *
 * Detects if the current working directory is a git worktree and extracts
 * information about the parent repository.
 *
 * Git worktrees have a `.git` file (not directory) containing:
 *   gitdir: /path/to/parent/.git/worktrees/<name>
 */

import { statSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

export interface WorktreeInfo {
  isWorktree: boolean;
  worktreeName: string | null;     // e.g., "yokohama"
  parentRepoPath: string | null;   // e.g., "/Users/alex/main"
  parentProjectName: string | null; // e.g., "main"
}

const NOT_A_WORKTREE: WorktreeInfo = {
  isWorktree: false,
  worktreeName: null,
  parentRepoPath: null,
  parentProjectName: null
};

/**
 * Detect if a directory is a git worktree and extract parent info.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns WorktreeInfo with parent details if worktree, otherwise isWorktree=false
 */
export function detectWorktree(cwd: string): WorktreeInfo {
  const gitPath = path.join(cwd, '.git');

  // Check if .git is a file (worktree) or directory (main repo)
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    // No .git at all - not a git repo
    return NOT_A_WORKTREE;
  }

  if (!stat.isFile()) {
    // .git is a directory = main repo, not a worktree
    return NOT_A_WORKTREE;
  }

  // Parse .git file to find parent repo
  let content: string;
  try {
    content = readFileSync(gitPath, 'utf-8').trim();
  } catch {
    return NOT_A_WORKTREE;
  }

  // Format: gitdir: /path/to/parent/.git/worktrees/<name>
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return NOT_A_WORKTREE;
  }

  const gitdirPath = match[1];

  // Extract: /path/to/parent from /path/to/parent/.git/worktrees/name
  // Handle both Unix and Windows paths
  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
  if (!worktreesMatch) {
    return NOT_A_WORKTREE;
  }

  const parentRepoPath = worktreesMatch[1];
  const worktreeName = path.basename(cwd);
  const parentProjectName = path.basename(parentRepoPath);

  return {
    isWorktree: true,
    worktreeName,
    parentRepoPath,
    parentProjectName
  };
}

/**
 * Discover all active worktree project names for a given repository.
 *
 * Reads .git/worktrees/ and extracts the basename of each worktree's
 * actual path from its gitdir file.
 *
 * @param repoPath - Absolute path to the repository (main or parent)
 * @returns Array of worktree project names (basenames of worktree paths)
 */
export function discoverAllWorktrees(parentRepoPath: string): string[] {
  const worktreesDir = path.join(parentRepoPath, '.git', 'worktrees');

  let entries: string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return [];
  }

  const worktrees: string[] = [];

  for (const entry of entries) {
    const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
    try {
      // gitdir file contains the absolute path to the worktree's .git file
      const worktreePath = path.dirname(readFileSync(gitdirFile, 'utf-8').trim());
      worktrees.push(path.basename(worktreePath));
    } catch {
      // Stale or broken worktree entry — skip
    }
  }

  return worktrees;
}
