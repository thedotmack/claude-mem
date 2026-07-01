import { homedir } from 'os'
import path from 'path';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

/** Per-project config file that may carry an explicit `projectName` override. */
const CONFIG_FILENAME = '.claude-mem.json';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

/** Read a non-empty `projectName` (or `project_name`) string from a config file. */
function readProjectNameField(configPath: string): string | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Missing file or invalid JSON — nothing to override with.
    return null;
  }
  const value = raw.projectName ?? raw.project_name;
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return null;
}

/**
 * Read an explicit project-name override from a `.claude-mem.json` config file.
 * Walks up from `startDir` (through the repo and up to the home directory) and
 * returns the first `projectName` string it finds, or null when none is set.
 *
 * This lets independent copies of a project (e.g. my-app, my-app-2, …) share
 * one memory: commit a `.claude-mem.json` with `{ "projectName": "my-app" }` and
 * every copy/worktree resolves to that name regardless of its folder name —
 * rather than the default git-repo-root / cwd basename.
 */
export function getConfiguredProjectName(startDir: string): string | null {
  const home = homedir();
  let dir = path.resolve(startDir);

  while (true) {
    const name = readProjectNameField(path.join(dir, CONFIG_FILENAME));
    if (name) {
      logger.info('PROJECT_NAME', 'Using project name from .claude-mem.json', {
        configDir: dir,
        projectName: name,
      });
      return name;
    }

    const parent = path.dirname(dir);
    // Stop after checking the home directory, or once we reach the FS root.
    if (dir === home || parent === dir) break;
    dir = parent;
  }

  return null;
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

  // An explicit `.claude-mem.json` { projectName } override wins over the
  // git-root / basename derivation, so independent copies of a project can be
  // pinned to one shared memory regardless of their folder names.
  const configured = getConfiguredProjectName(expanded);
  if (configured) return configured;

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
  allProjects: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);

  // An explicit `.claude-mem.json` name is authoritative: skip worktree
  // compositing so every copy/worktree collapses to the one configured project.
  if (getConfiguredProjectName(expandedCwd)) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

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
