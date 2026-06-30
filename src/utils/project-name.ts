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
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to basename', { dir }, err);
    return null;
  }
}

function resolvePath(p: string): string {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function normalizePath(p: string): string {
  const resolved = resolvePath(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

// .git FILE (not dir) means this is a linked worktree root, not the main repo.
function isLinkedWorktreeRoot(dir: string): boolean {
  try { return statSync(path.join(dir, '.git')).isFile(); } catch { return false; }
}

function findEnclosingLinkedWorktreeRoot(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (isLinkedWorktreeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Walk from start toward repoRoot, excluding the repo root itself.
function findNearestPackageRoot(start: string, repoRoot: string): string | null {
  let dir = resolvePath(start);
  while (true) {
    if (samePath(dir, repoRoot)) break;
    try {
      if (statSync(path.join(dir, 'package.json')).isFile()) return dir;
    } catch {
      // No package.json at this level.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findTopLevelSubprojectRoot(start: string, repoRoot: string): string {
  const root = resolvePath(repoRoot);
  const relative = path.relative(root, resolvePath(start));
  const [firstSegment] = relative.split(path.sep).filter(Boolean);
  return firstSegment ? path.join(root, firstSegment) : resolvePath(start);
}

function toProjectPath(relativePath: string): string {
  return relativePath.split(path.sep).filter(Boolean).join('/');
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)
  const linkedWorktreeRoot = findEnclosingLinkedWorktreeRoot(expanded);

  if (linkedWorktreeRoot) {
    return path.basename(linkedWorktreeRoot);
  }

  const repoRoot = findGitRepoRoot(expanded);
  if (repoRoot) {
    if (samePath(expanded, repoRoot)) {
      return path.basename(repoRoot);
    }

    const subprojectRoot =
      findNearestPackageRoot(expanded, repoRoot) ??
      findTopLevelSubprojectRoot(expanded, repoRoot);
    const relativeBoundary = toProjectPath(
      path.relative(resolvePath(repoRoot), resolvePath(subprojectRoot))
    );
    return `${path.basename(repoRoot)}/${relativeBoundary}`;
  }

  const basename = path.basename(expanded);

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
  const linkedWorktreeRoot = findEnclosingLinkedWorktreeRoot(expandedCwd);
  const repoRoot = findGitRepoRoot(expandedCwd) ?? linkedWorktreeRoot;
  const directWorktreeInfo = detectWorktree(expandedCwd);
  const worktreeInfo = directWorktreeInfo.isWorktree
    ? directWorktreeInfo
    : (linkedWorktreeRoot ? detectWorktree(linkedWorktreeRoot) : directWorktreeInfo);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const worktreeName = linkedWorktreeRoot
      ? path.basename(linkedWorktreeRoot)
      : cwdProjectName;
    const composite = `${worktreeInfo.parentProjectName}/${worktreeName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, composite]
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
