import { homedir } from 'os'
import path from 'path';
import { spawnSync } from 'child_process';
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
 * Try to derive a stable project name from the git common directory.
 *
 * Uses `git rev-parse --git-common-dir` which resolves to the shared .git
 * directory for both main repos and worktrees. This ensures:
 * - All worktrees of the same repo share the same project name
 * - Different repos with the same directory basename get different keys
 *   (because the common git dir's parent path will differ)
 *
 * Returns null if the cwd is not inside a git repository.
 */
function getGitProjectName(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (result.status !== 0 || !result.stdout) return null;

    const gitCommonDir = result.stdout.trim();
    if (!gitCommonDir) return null;

    // The common git dir is typically "/path/to/repo/.git"
    // We want the basename of the parent: "repo"
    const parentOfGitDir = gitCommonDir.endsWith('.git')
      ? path.dirname(gitCommonDir)
      : gitCommonDir;

    const projectName = path.basename(parentOfGitDir);

    // Guard against degenerate cases (root dir, empty basename)
    if (!projectName || projectName === '.' || projectName === '/') return null;

    return projectName;
  } catch {
    return null;
  }
}

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes, unexpanded ~
 *
 * Strategy:
 * 1. First try git-common-dir to unify worktrees and avoid basename collisions
 * 2. Fall back to path.basename(cwd) if not in a git repo
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

  // Try git-common-dir first for stable, worktree-aware project naming
  const gitProjectName = getGitProjectName(expanded);
  if (gitProjectName) {
    return gitProjectName;
  }

  // Fall back to basename for non-git directories
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
