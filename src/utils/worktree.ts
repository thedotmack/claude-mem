
import { statSync, readFileSync } from 'fs';
import path from 'path';

export interface WorktreeInfo {
  isWorktree: boolean;
  worktreeName: string | null;     
  parentRepoPath: string | null;   
  parentProjectName: string | null; 
}

const NOT_A_WORKTREE: WorktreeInfo = {
  isWorktree: false,
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
      console.warn(`[worktree] Unexpected error checking .git:`, error);
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
    console.warn(`[worktree] Failed to read .git file:`, error instanceof Error ? error.message : String(error));
    return NOT_A_WORKTREE;
  }

  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return NOT_A_WORKTREE;
  }

  const gitdirPath = match[1];

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
