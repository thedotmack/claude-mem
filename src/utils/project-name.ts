import path from 'path';
import { execFileSync } from 'child_process';
import { expandHome } from '../shared/expand-home.js';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

/**
 * Resolve the git repository ROOT for a directory, so a project's name is
 * stable across its subdirectories and worktrees (#2663). Returns the absolute
 * repo-root path, or null when `dir` is not inside a git repo (or git is
 * unavailable). `--show-toplevel` resolves to the working-tree root even when
 * invoked from a worktree or a nested subdirectory.
 */
function findGitRepoRoot(dir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return root || null;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to basename', { dir }, err);
    return null;
  }
}

export function getProjectName(
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandHome(cwd, platform);

  // #2663 — derive the project name from the git repo root when inside a repo so
  // the name is stable across subdirectories/worktrees. Fall back to the cwd
  // basename when not in a repo.
  const repoRoot = findGitRepoRoot(expanded);
  const nameSource = repoRoot ?? expanded;

  const basename = path.basename(nameSource);

  if (basename === '') {
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

  // #3531 — fold ASCII case so two checkouts of the same repo whose directory
  // names differ only in case (e.g. `PasteyPal` vs `pasteypal`) resolve to one
  // memory bucket instead of silently forking into two. Fold ONLY ASCII A–Z:
  // the retrieval queries compare with SQLite's NOCASE collation, which is
  // ASCII-only, so lowercasing non-ASCII here (e.g. `É`→`é`) would disagree with
  // NOCASE and strand rows stored under the original casing.
  return basename.replace(/[A-Z]/g, ch => ch.toLowerCase());
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
}

export function getProjectContext(
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): ProjectContext {
  const cwdProjectName = getProjectName(cwd, platform);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandHome(cwd, platform);
  // #3262 — detectWorktree stats `<cwd>/.git`, which only exists at the
  // worktree root. Resolve the git working-tree root first (same pattern as
  // getProjectName / #2663) so sessions started in a subdirectory still get
  // the parent/worktree compound key.
  const worktreeInfo = detectWorktree(findGitRepoRoot(expandedCwd) ?? expandedCwd);

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
