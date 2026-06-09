
import { statSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface WorktreeInfo {
  kind: 'none' | 'worktree' | 'submodule';
  isWorktree: boolean;
  isSubmodule: boolean;
  worktreeName: string | null;     
  parentRepoPath: string | null;   
  parentProjectName: string | null; 
}

const NOT_A_WORKTREE: WorktreeInfo = {
  kind: 'none',
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

  const gitdirPath = match[1];

  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);
  if (worktreesMatch) {
    const parentRepoPath = worktreesMatch[1];
    const worktreeName = path.basename(cwd);
    const parentProjectName = path.basename(parentRepoPath);

    return {
      kind: 'worktree',
      isWorktree: true,
      isSubmodule: false,
      worktreeName,
      parentRepoPath,
      parentProjectName
    };
  }

  const normalizedGitdirPath = gitdirPath.replace(/[/\\]+$/, '');
  const submoduleMatch = normalizedGitdirPath.match(/^(.*?)[/\\]\.git[/\\]modules[/\\].+$/);
  if (!submoduleMatch) {
    return NOT_A_WORKTREE;
  }

  const parentRepoPath = submoduleMatch[1];
  const parentProjectName = path.basename(parentRepoPath);

  return {
    kind: 'submodule',
    isWorktree: false,
    isSubmodule: true,
    worktreeName: null,
    parentRepoPath,
    parentProjectName
  };
}
