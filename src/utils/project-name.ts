import { homedir } from 'os'
import path from 'path';
import { statSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import picomatch from 'picomatch';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';
import type { Environment } from '../shared/SettingsDefaultsManager.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';

/** Per-project config file that may carry an explicit `projectName` override. */
const CONFIG_FILENAME = '.claude-mem.json';

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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function hasNestedPackageJson(repoRoot: string): boolean {
  const root = resolvePath(repoRoot);
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      const entryPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === 'package.json' && !samePath(dir, root)) {
        return true;
      }

      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }

  return false;
}

function shouldUseTopLevelSubprojectFallback(repoRoot: string): boolean {
  const rootPackageJson = path.join(repoRoot, 'package.json');
  let rootManifestState: 'file' | 'missing' | 'unreadable' = 'file';

  try {
    if (!statSync(rootPackageJson).isFile()) {
      rootManifestState = 'unreadable';
    }
  } catch (error) {
    rootManifestState = isErrnoException(error) && error.code === 'ENOENT'
      ? 'missing'
      : 'unreadable';
  }

  if (rootManifestState === 'missing') {
    return hasNestedPackageJson(repoRoot);
  }

  if (rootManifestState === 'unreadable') {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    return Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces.length > 0
      : Array.isArray(packageJson.workspaces?.packages) && packageJson.workspaces.packages.length > 0;
  } catch {
    return false;
  }
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
  if (repoRoot) {
    if (samePath(expanded, repoRoot)) {
      return path.basename(repoRoot);
    }

    const packageRoot = findNearestPackageRoot(expanded, repoRoot);
    if (!packageRoot && !shouldUseTopLevelSubprojectFallback(repoRoot)) {
      return path.basename(repoRoot);
    }

    const subprojectRoot = packageRoot ?? findTopLevelSubprojectRoot(expanded, repoRoot);
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

export function getDreamProjectName(projectName: string): string {
  return projectName.endsWith(':dream') ? projectName : `${projectName}:dream`;
}

function withDreamProjects(projects: string[]): string[] {
  return [
    ...projects.map(getDreamProjectName),
    ...projects,
  ];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: withDreamProjects([cwdProjectName]) };
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
      allProjects: withDreamProjects([worktreeInfo.parentProjectName, composite])
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: withDreamProjects([cwdProjectName]) };
}
