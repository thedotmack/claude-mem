import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';

/**
 * Opt-in (CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote): derive the project name from
 * the git `origin` remote instead of the folder basename. Default ('path')
 * preserves existing behavior. Reading settings is cached (loadFromFileOnce).
 */
function useRemoteProjectName(): boolean {
  try {
    return String(loadFromFileOnce().CLAUDE_MEM_PROJECT_NAME_SOURCE ?? 'path')
      .trim()
      .toLowerCase() === 'git-remote';
  } catch {
    return false;
  }
}

/**
 * Resolve a stable `org/repo` slug from the repo's `origin` remote URL. This is
 * stable across directory renames (unlike the folder basename) and identical
 * across a repo's worktrees (they share remotes). Handles scp-style
 * (`git@host:org/repo.git`) and URL forms (`https://host/org/repo.git`).
 * Returns null when there is no `origin` remote or the URL can't be parsed.
 */
function deriveSlugFromRemote(dir: string): string | null {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  return parseOriginUrlToSlug(url);
}

/**
 * Pure parser: turn a git remote URL into an `org/repo` slug. Handles scp-style
 * (`git@host:org/repo.git`) and URL forms (`https://host/org/repo.git`, with or
 * without a trailing slash or `.git`). Returns the last two path segments
 * (`org/repo`), a single segment when that's all there is, or null when the URL
 * is empty/unparseable. Exported for unit testing.
 */
export function parseOriginUrlToSlug(url: string): string | null {
  if (!url || !url.trim()) return null;
  const cleaned = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  // scp-style: user@host:org/repo  → capture the part after the colon.
  const scp = cleaned.match(/^[^/@]+@[^:]+:(.+)$/);
  const pathPart = scp
    ? scp[1]
    // URL form: scheme://host/org/repo → strip scheme + host.
    : cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '');

  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length >= 2) return segments.slice(-2).join('/');
  if (segments.length === 1) return segments[0];
  return null;
}

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

  // Opt-in: derive a stable org/repo slug from the origin remote. Falls through
  // to the folder-basename logic below when disabled, no remote, or unparseable.
  if (repoRoot && useRemoteProjectName()) {
    const slug = deriveSlugFromRemote(repoRoot);
    if (slug) return slug;
  }

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
  allProjects: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  const worktreeInfo = detectWorktree(expandedCwd);

  // In remote mode the origin URL is the canonical repo identity, and a repo's
  // worktrees share its remotes — so cwdProjectName already collapses worktrees
  // onto the parent repo. Skip the parent/child compositing to avoid doubling.
  if (useRemoteProjectName()) {
    return {
      primary: cwdProjectName,
      parent: null,
      isWorktree: worktreeInfo.isWorktree,
      allProjects: [cwdProjectName]
    };
  }

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
