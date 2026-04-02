import path from 'path';
import { logger } from './logger.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { detectWorktree, discoverAllWorktrees } from './worktree.js';

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
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
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

/**
 * Project context with worktree awareness
 */
export interface ProjectContext {
  /** The current project name (worktree or main repo) */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** All projects to query: [primary] for main repo, [parent, primary] for worktree */
  allProjects: string[];
}

/**
 * Get project context with worktree detection.
 *
 * When in a worktree, returns both the worktree project name and parent project name
 * for unified timeline queries.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const primary = getProjectName(cwd);

  if (!cwd) {
    return { primary, parent: null, isWorktree: false, allProjects: [primary] };
  }

  const worktreeInfo = detectWorktree(cwd);
  const sharedContext = SettingsDefaultsManager.getBool('CLAUDE_MEM_WORKTREE_SHARED_CONTEXT');

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName && worktreeInfo.parentRepoPath) {
    if (sharedContext) {
      // In a worktree: include parent + all siblings for unified context
      const worktrees = discoverAllWorktrees(worktreeInfo.parentRepoPath);
      const allProjects = dedupePreservingOrder([worktreeInfo.parentProjectName, ...worktrees, primary]);
      return { primary, parent: worktreeInfo.parentProjectName, isWorktree: true, allProjects };
    }
    // Original behavior: parent + self only
    return {
      primary,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, primary]
    };
  }

  if (sharedContext) {
    // Main repo: check if it has active worktrees
    const worktrees = discoverAllWorktrees(cwd);
    if (worktrees.length > 0) {
      const allProjects = dedupePreservingOrder([primary, ...worktrees]);
      return { primary, parent: null, isWorktree: false, allProjects };
    }
  }

  return { primary, parent: null, isWorktree: false, allProjects: [primary] };
}

/**
 * Remove duplicates from an array while preserving insertion order.
 */
function dedupePreservingOrder(items: string[]): string[] {
  return [...new Set(items)];
}
