import path from 'path';
import { logger } from './logger.js';
import { detectWorktree, type WorktreeInfo } from './worktree.js';

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @param precomputedWorktreeInfo - Optional pre-computed worktree info to avoid duplicate detectWorktree() calls
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(
  cwd: string | null | undefined,
  precomputedWorktreeInfo?: WorktreeInfo
): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Check if this is a worktree — if so, use the parent repo name
  const worktreeInfo = precomputedWorktreeInfo ?? detectWorktree(cwd);
  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    return worktreeInfo.parentProjectName;
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
  /** The project name (worktrees resolve to parent repo name) */
  primary: string;
  /** Always null (retained for backward compatibility; worktrees resolve primary to parent repo name) */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** All projects to query: [primary] plus worktree alias if applicable (for reading legacy data) */
  allProjects: string[];
}

/**
 * Get project context with worktree detection.
 *
 * When in a worktree, primary resolves to the parent repo name so all
 * worktrees share a single project identity.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  if (!cwd || cwd.trim() === '') {
    const primary = getProjectName(cwd);
    return { primary, parent: null, isWorktree: false, allProjects: [primary] };
  }

  // Single detectWorktree() call, passed to getProjectName() to avoid duplicate I/O
  const worktreeInfo = detectWorktree(cwd);
  const primary = getProjectName(cwd, worktreeInfo);

  // Include worktree dir name as alias so reads pick up legacy data stored
  // under the old (pre-fix) worktree-scoped project name
  const worktreeAlias = worktreeInfo.isWorktree ? path.basename(cwd) : null;
  const allProjects = worktreeAlias && worktreeAlias !== primary
    ? [primary, worktreeAlias]
    : [primary];

  return {
    primary,
    parent: null,
    isWorktree: worktreeInfo.isWorktree,
    allProjects
  };
}
