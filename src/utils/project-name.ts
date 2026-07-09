import { homedir } from 'os'
import path from 'path';
import { readdirSync, readFileSync, realpathSync, statSync } from 'fs';
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
