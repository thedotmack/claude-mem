import { homedir } from 'os'
import path from 'path';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

/**
 * Expand leading ~ to the user's home directory.
 * Handles "~", "~/", and "~/subpath" but not "~user/" (which is rare in cwd).
 */
function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes, unexpanded ~
 *
 * @param cwd - Current working directory (absolute path, or ~-prefixed path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Expand leading ~ before path operations
  const expanded = expandTilde(cwd)

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(expanded);

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
  /** Canonical project name for writes/queries; `parent/worktree` when in a worktree */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** Projects to query for reads. In a worktree: `[parent, composite]` so
   *  main-repo context flows into every worktree while sibling worktrees stay
   *  isolated. In the main repo: `[primary]`. Writes always use `.primary`. */
  allProjects: string[];
}

/**
 * Get project context with worktree detection.
 *
 * Each worktree is its own bucket. When in a worktree, `primary` is the
 * composite `parent/worktree` (e.g. `claude-mem/dar-es-salaam`) so worktrees
 * are uniquely identified and grouped under their parent project without
 * mixing observations across them. In the main repo, `primary` is just the
 * project basename.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  const worktreeInfo = detectWorktree(expandedCwd);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const composite = `${worktreeInfo.parentProjectName}/${cwdProjectName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, composite]
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
