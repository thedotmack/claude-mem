import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

const PROJECT_MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'deno.json',
  'deno.jsonc',
  'composer.json',
  'Gemfile',
  'mix.exs',
];

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

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findNearestManifestDir(cwd: string, repoRoot: string): string | null {
  let current = path.resolve(cwd);
  const root = path.resolve(repoRoot);

  while (isPathInsideOrEqual(current, root) && current !== root) {
    if (PROJECT_MANIFESTS.some(manifest => existsSync(path.join(current, manifest)))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function getRepoProjectKey(repoRoot: string, cwd: string): string {
  const root = path.resolve(repoRoot);
  const resolvedCwd = path.resolve(cwd);
  const repoName = path.basename(root);

  if (!repoName || !isPathInsideOrEqual(resolvedCwd, root)) {
    return repoName;
  }

  const relativeCwd = path.relative(root, resolvedCwd);
  if (relativeCwd === '') {
    return repoName;
  }

  const nearestManifestDir = findNearestManifestDir(resolvedCwd, root);
  const firstSegment = relativeCwd.split(path.sep).filter(Boolean)[0];
  const boundary = nearestManifestDir ?? (firstSegment ? path.join(root, firstSegment) : root);
  const relativeBoundary = path.relative(root, boundary).split(path.sep).join('/');

  return relativeBoundary ? `${repoName}/${relativeBoundary}` : repoName;
}

function findNearestGitContextRoot(dir: string): string | null {
  let current = path.resolve(dir);

  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      if (statSync(gitPath).isFile()) {
        return current;
      }
    } catch {
      // Keep walking upward until a gitdir file or filesystem root is found.
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
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
  if (repoRoot) {
    return getRepoProjectKey(repoRoot, expanded);
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
  if (!cwd) {
    const cwdProjectName = getProjectName(cwd);
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  const repoRoot = findGitRepoRoot(expandedCwd);
  const contextRoot = findNearestGitContextRoot(expandedCwd);
  const validContextRoot = contextRoot && (!repoRoot || isPathInsideOrEqual(contextRoot, repoRoot))
    ? contextRoot
    : null;
  const worktreeInfo = detectWorktree(validContextRoot ?? repoRoot ?? expandedCwd);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const worktreeName = worktreeInfo.worktreeName ?? path.basename(validContextRoot ?? expandedCwd);
    const composite = `${worktreeInfo.parentProjectName}/${worktreeName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, composite]
    };
  }

  if (worktreeInfo.isSubmodule && worktreeInfo.parentProjectName) {
    return {
      primary: worktreeInfo.parentProjectName,
      parent: null,
      isWorktree: false,
      allProjects: [worktreeInfo.parentProjectName]
    };
  }

  const cwdProjectName = getProjectName(cwd);

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
