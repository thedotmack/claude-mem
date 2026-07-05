
import { statSync, readFileSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface WorktreeInfo {
  isWorktree: boolean;
  isSubmodule: boolean;
  kind: 'worktree' | 'submodule' | null;
  worktreeName: string | null;     
  parentRepoPath: string | null;   
  parentProjectName: string | null; 
}

const NOT_A_WORKTREE: WorktreeInfo = {
  isWorktree: false,
  isSubmodule: false,
  kind: null,
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
    const worktreeName = path.basename(cwd);
    const parentProjectName = path.basename(parentRepoPath);

    return {
      isWorktree: true,
      isSubmodule: false,
      kind: 'worktree',
      worktreeName,
      parentRepoPath,
      parentProjectName
    };
  }

  const modulesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]modules[/\\].+$/);
  if (modulesMatch) {
    const parentRepoPath = modulesMatch[1];
    return {
      isWorktree: false,
      isSubmodule: true,
      kind: 'submodule',
      worktreeName: path.basename(cwd),
      parentRepoPath,
      parentProjectName: path.basename(parentRepoPath)
    };
  }

  return NOT_A_WORKTREE;
}
