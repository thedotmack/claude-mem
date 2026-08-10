import { homedir } from 'os'
import path from 'path';
import { existsSync } from 'fs';
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
      windowsHide: true,
    }).trim();
    return root || null;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Not a git repo, git not installed, or dir does not exist — fall back further.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to non-git root', { dir }, err);
    return null;
  }
}

/**
 * Markers that indicate a non-git directory is still a project root (#3194).
 * Do not treat `~/.claude` as a marker: that is Claude Code's global config
 * directory, present for every user, and would collapse all home subdirs into
 * one project key.
 */
const NON_GIT_PROJECT_MARKERS = [
  'CLAUDE.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  '.claude-mem.json',
] as const;

function hasNonGitProjectMarker(dir: string): boolean {
  for (const marker of NON_GIT_PROJECT_MARKERS) {
    if (existsSync(path.join(dir, marker))) {
      return true;
    }
  }
  return false;
}

/**
 * Walk up from `dir` looking for a non-git project root marker. Returns the
 * absolute directory that owns the marker, or null when none is found (or the
 * path does not exist). Stops at the filesystem root.
 */
function findNonGitProjectRoot(dir: string): string | null {
  let current = path.resolve(dir);
  const { root } = path.parse(current);

  // Cap walk depth so a huge path cannot spin; filesystem roots are shallow.
  for (let i = 0; i < 64; i++) {
    if (hasNonGitProjectMarker(current)) {
      return current;
    }
    if (current === root) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

  // #2663 — derive the project name from the git repo root when inside a repo so
  // the name is stable across subdirectories/worktrees.
  // #3194 — outside a repo, walk up to a project-marker directory (CLAUDE.md,
  // package.json, ...) so subdir launches share the parent project key with
  // capture. Fall back to the cwd basename when no marker exists.
  const repoRoot = findGitRepoRoot(expanded);
  const markerRoot = repoRoot ? null : findNonGitProjectRoot(expanded);
  const nameSource = repoRoot ?? markerRoot ?? expanded;

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

/**
 * When SessionStart reports a subdirectory cwd but capture used a parent
 * directory (common outside git repos), include the immediate parent basename
 * in the read scope so context injection can still find parent-scoped memory.
 */
function withNonGitParentReadScope(cwd: string, primary: string): string[] {
  const parentDir = path.dirname(path.resolve(cwd));
  const parentBase = path.basename(parentDir);
  if (!parentBase || parentBase === primary) {
    return [primary];
  }
  // Skip filesystem roots / drive letters (empty meaningful project keys).
  if (parentDir === path.parse(parentDir).root) {
    return [primary];
  }
  return [parentBase, primary];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
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

  const repoRoot = findGitRepoRoot(expandedCwd);
  if (!repoRoot) {
    const markerRoot = findNonGitProjectRoot(expandedCwd);
    // Marker already folded into primary via getProjectName. When we still
    // fell back to basename(cwd), widen read scope to the immediate parent
    // (#3194) so inject can meet capture's parent key.
    if (!markerRoot) {
      const allProjects = withNonGitParentReadScope(expandedCwd, cwdProjectName);
      const parent = allProjects.length > 1 ? allProjects[0] : null;
      return { primary: cwdProjectName, parent, isWorktree: false, allProjects };
    }
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
