import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree, type WorktreeInfo } from './worktree.js';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

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

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

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

  return basename;
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  /** Set when `primary` is a composite key for a submodule (#2842). */
  isSubmodule: boolean;
  allProjects: string[];
}

/**
 * A submodule's key component is its path under the superproject, not its
 * basename: two nested submodules can share a leaf repo name
 * (`outer/alpha/shared` and `outer/beta/shared`), and keying on the basename
 * alone collapses them into one project whose observations overwrite each
 * other. Worktrees keep the basename — they usually live outside the parent
 * tree, where a relative path is meaningless.
 */
function submoduleLeaf(info: WorktreeInfo, repoRoot: string): string | null {
  if (!info.isSubmodule || !info.parentRepoPath) return null;
  const relative = path.relative(info.parentRepoPath, repoRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  // #3262 — detectWorktree stats `<cwd>/.git`, which only exists at the
  // worktree root. Resolve the git working-tree root first (same pattern as
  // getProjectName / #2663) so sessions started in a subdirectory still get
  // the parent/worktree compound key.
  const repoRoot = findGitRepoRoot(expandedCwd) ?? expandedCwd;
  const worktreeInfo = detectWorktree(repoRoot);

  if ((worktreeInfo.isWorktree || worktreeInfo.isSubmodule) && worktreeInfo.parentProjectName) {
    const composite = `${worktreeInfo.parentProjectName}/${submoduleLeaf(worktreeInfo, repoRoot) ?? cwdProjectName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: worktreeInfo.isWorktree,
      isSubmodule: worktreeInfo.isSubmodule,
      allProjects: [worktreeInfo.parentProjectName, composite]
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [cwdProjectName] };
}
