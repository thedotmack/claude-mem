
import { statSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface WorktreeInfo {
  isWorktree: boolean;
  /** Nests under a superproject like a worktree nests under its parent (#2842). */
  isSubmodule: boolean;
  worktreeName: string | null;
  parentRepoPath: string | null;
  parentProjectName: string | null;
}

const NOT_A_WORKTREE: WorktreeInfo = {
  isWorktree: false,
  isSubmodule: false,
  worktreeName: null,
  parentRepoPath: null,
  parentProjectName: null
};

export function detectWorktree(cwd: string): WorktreeInfo {
  const gitPath = path.join(cwd, '.git');

  let stat;
  try {
    stat = statSync(gitPath);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('GIT', 'Unexpected error checking .git', { error: error instanceof Error ? error.message : String(error) });
    }
    return NOT_A_WORKTREE;
  }

  if (!stat.isFile()) {
    return NOT_A_WORKTREE;
  }

  let content: string;
  try {
    content = readFileSync(gitPath, 'utf-8').trim();
  } catch (error: unknown) {
    logger.warn('GIT', 'Failed to read .git file', { error: error instanceof Error ? error.message : String(error) });
    return NOT_A_WORKTREE;
  }

  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return NOT_A_WORKTREE;
  }

  const gitdirPath = path.resolve(path.dirname(gitPath), match[1]);

  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
  if (worktreesMatch) {
    const parentRepoPath = worktreesMatch[1];
    return {
      isWorktree: true,
      isSubmodule: false,
      worktreeName: path.basename(cwd),
      parentRepoPath,
      parentProjectName: path.basename(parentRepoPath)
    };
  }

  // Submodules point at `<super>/.git/modules/<name>`, which the worktrees
  // pattern never matched — they resolved to their own leaf name, a new empty
  // project, so context injection reported "no memory yet" (#2842).
  const submoduleMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]modules[/\\](.+)$/);
  if (submoduleMatch) {
    const parentRepoPath = submoduleMatch[1];
    return {
      isWorktree: false,
      isSubmodule: true,
      worktreeName: path.basename(cwd),
      parentRepoPath,
      parentProjectName: path.basename(parentRepoPath)
    };
  }

  return NOT_A_WORKTREE;
}
