import { homedir } from 'os'
import path from 'path';
import { realpathSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

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
    }).trim();
    return root || null;
  } catch {
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const realOrResolve = (p: string) => { try { return realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
  const left = realOrResolve(a);
  const right = realOrResolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// .git FILE (not dir) means this is a linked worktree root, not the main repo.
function isLinkedWorktreeRoot(dir: string): boolean {
  try { return statSync(path.join(dir, '.git')).isFile(); } catch { return false; }
}

// Treat cwd as an independent package only when it has its own package.json.
function hasOwnPackageJson(dir: string): boolean {
  try { return statSync(path.join(dir, 'package.json')).isFile(); } catch { return false; }
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
  // #2882 — when cwd is a package root inside a monorepo (has its own package.json)
  // or a linked worktree root (has a .git file), use the cwd basename so each
  // package/worktree gets an independent project name.
  const repoRoot = findGitRepoRoot(expanded);
  const isSubdir = repoRoot != null && !samePath(expanded, repoRoot);
  const nameSource = isSubdir && (isLinkedWorktreeRoot(expanded) || hasOwnPackageJson(expanded))
    ? expanded
    : (repoRoot ?? expanded);

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
  allProjects: string[];
}

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
