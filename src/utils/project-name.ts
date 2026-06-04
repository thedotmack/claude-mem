import { homedir } from 'os'
import path from 'path';
import { statSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import picomatch from 'picomatch';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';
import type { Environment } from '../shared/SettingsDefaultsManager.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

let cachedEnvironments: Environment[] | null = null;
let cachedSettingsMtime = 0;
let lastCacheTime = 0;
let settingsPathOverride: string | null = null;
const CACHE_DEBOUNCE_MS = 100;

export function resetEnvironmentsCache(): void {
  cachedEnvironments = null;
  cachedSettingsMtime = 0;
  lastCacheTime = 0;
}

/**
 * Override the settings file path used by loadEnvironments.
 * Production code must not call this — it exists so tests can point at a
 * temporary settings file instead of mutating the user's real
 * ~/.claude-mem/settings.json.
 */
export function setEnvironmentsSettingsPathForTesting(p: string | null): void {
  settingsPathOverride = p;
  resetEnvironmentsCache();
}

function getSettingsPath(): string {
  return settingsPathOverride ?? path.join(homedir(), '.claude-mem', 'settings.json');
}

export function loadEnvironments(): Environment[] {
  const now = Date.now();
  if (cachedEnvironments !== null && now - lastCacheTime < CACHE_DEBOUNCE_MS) {
    return cachedEnvironments;
  }

  try {
    const settingsPath = getSettingsPath();
    const mtime = statSync(settingsPath).mtimeMs;

    if (cachedEnvironments !== null && mtime === cachedSettingsMtime) {
      lastCacheTime = now;
      return cachedEnvironments;
    }

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const raw = settings.environments;
    // settings.environments is typed as string, but loadFromFile hands back
    // whatever JSON.parse produced from the on-disk file — so it can be either
    // a JSON string ("[{...}]") or a native array ([{...}]) depending on how
    // the user wrote it. Accept both shapes.
    cachedEnvironments = Array.isArray(raw)
      ? (raw as Environment[])
      : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
    cachedSettingsMtime = mtime;
    lastCacheTime = now;
    return cachedEnvironments!;
  } catch {
    cachedEnvironments = [];
    lastCacheTime = now;
    return cachedEnvironments;
  }
}

function matchEnvironment(cwd: string): string | null {
  const environments = loadEnvironments();
  if (environments.length === 0) return null;

  let normalizedCwd = cwd;
  try { normalizedCwd = realpathSync(cwd); } catch { /* path doesn't exist, use original */ }

  const expandedCwd = expandTilde(normalizedCwd);

  for (const env of environments) {
    for (const pattern of env.patterns) {
      const expandedPattern = expandTilde(pattern);
      if (picomatch(expandedPattern)(expandedCwd)) {
        logger.info('PROJECT_NAME', 'Environment matched', { cwd, envName: env.name, pattern });
        return env.name;
      }
    }
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

  // Environment matching wins over both git-repo-root and basename fallback —
  // a user-configured environment is an explicit declaration of identity.
  const envName = matchEnvironment(expanded);
  if (envName) {
    return envName;
  }

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
