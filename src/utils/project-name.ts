import path from 'path';
import { logger } from './logger.js';
import { detectWorktree, type WorktreeInfo } from './worktree.js';

/**
 * Resolve project name and worktree info from a working directory.
 * Single call to detectWorktree, used by both getProjectName and getProjectContext.
 */
function resolveProject(cwd: string | null | undefined): { name: string; worktreeInfo: WorktreeInfo | null } {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return { name: 'unknown-project', worktreeInfo: null };
  }

  // If in a git worktree, use the parent repo name so all worktrees
  // of the same repo map to the same project
  const worktreeInfo = detectWorktree(cwd);
  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    logger.info('PROJECT_NAME', 'Worktree detected, using parent project', {
      cwd,
      worktreeName: worktreeInfo.worktreeName,
      parentProject: worktreeInfo.parentProjectName
    });
    return { name: worktreeInfo.parentProjectName, worktreeInfo };
  }

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    // Extract drive letter on Windows, or use 'root' on Unix
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return { name: projectName, worktreeInfo };
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return { name: 'unknown-project', worktreeInfo };
  }

  return { name: basename, worktreeInfo };
}

/**
 * Extract project name from working directory path.
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes.
 * For git worktrees, returns the parent repo name so all worktrees
 * of the same repo map to the same project.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  return resolveProject(cwd).name;
}

/**
 * Project context with worktree awareness
 */
export interface ProjectContext {
  /** The current project name (resolves to parent repo name for worktrees) */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** All projects to query (always [primary] since worktrees resolve to parent) */
  allProjects: string[];
}

/**
 * Get project context with worktree detection.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const { name: primary, worktreeInfo } = resolveProject(cwd);

  if (worktreeInfo?.isWorktree) {
    return {
      primary,
      parent: null,
      isWorktree: true,
      allProjects: [primary]
    };
  }

  return { primary, parent: null, isWorktree: false, allProjects: [primary] };
}
