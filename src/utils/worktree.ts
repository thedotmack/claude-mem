
import { statSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface WorktreeInfo {
  isWorktree: boolean;
  /**
   * #2842 — a git submodule is a nested checkout that folds into its
   * superproject the same way a worktree folds into its parent. Callers that
   * only care "does this nest under a parent repo?" should test
   * `isWorktree || isSubmodule`.
   */
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

  // #2842 — a submodule's .git file points at `<super>/.git/modules/<name>`
  // (nested submodules extend that with further `/modules/` segments), which
  // the worktrees pattern above never matched. Without this branch a submodule
  // session resolved to its own leaf name: a brand-new, empty project, so
  // context injection reported "no memory yet" despite a rich superproject
  // history.
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
