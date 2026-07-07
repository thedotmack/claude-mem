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
    return realpathSync(p);
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

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(resolvePath(parent), resolvePath(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isLinkedWorktreeRoot(dir: string): boolean {
  const dotGit = path.join(dir, '.git');
  try {
    if (!statSync(dotGit).isFile()) return false;
    const content = readFileSync(dotGit, 'utf-8').trim();
    return /^gitdir:\s*.+[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/i.test(content);
  } catch {
    return false;
  }
}

function findEnclosingLinkedWorktreeRoot(startDir: string): string | null {
  let dir = resolvePath(startDir);
  while (true) {
    if (isLinkedWorktreeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hasPackageJson(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}

function findNearestPackageRoot(startDir: string, repoRoot: string): string | null {
  let dir = resolvePath(startDir);
  const root = resolvePath(repoRoot);

  while (isInsidePath(dir, root) && !samePath(dir, root)) {
    if (hasPackageJson(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function rootDeclaresWorkspaces(repoRoot: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    if (Array.isArray(packageJson.workspaces)) return packageJson.workspaces.length > 0;
    return Array.isArray(packageJson.workspaces?.packages) && packageJson.workspaces.packages.length > 0;
  } catch {
    return false;
  }
}

function hasNestedPackageRoot(repoRoot: string): boolean {
  const skip = new Set(['.git', 'node_modules', '.claude-mem', 'dist', 'build']);

  try {
    for (const topEntry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (!topEntry.isDirectory() || skip.has(topEntry.name)) continue;
      const topDir = path.join(repoRoot, topEntry.name);
      if (hasPackageJson(topDir)) return true;

      try {
        for (const childEntry of readdirSync(topDir, { withFileTypes: true })) {
          if (!childEntry.isDirectory() || skip.has(childEntry.name)) continue;
          if (hasPackageJson(path.join(topDir, childEntry.name))) return true;
        }
      } catch {
        // Ignore unreadable child directories; project-name detection is best effort.
      }
    }
  } catch {
    return false;
  }

  return false;
}

function shouldUseTopLevelSubprojectFallback(repoRoot: string): boolean {
  return rootDeclaresWorkspaces(repoRoot) || hasNestedPackageRoot(repoRoot);
}

function findTopLevelSubprojectRoot(startDir: string, repoRoot: string): string {
  const relative = path.relative(resolvePath(repoRoot), resolvePath(startDir));
  const [firstSegment] = relative.split(path.sep).filter(Boolean);
  return firstSegment ? path.join(repoRoot, firstSegment) : repoRoot;
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

  // An explicit `.claude-mem.json` { projectName } override wins over the
  // git-root / basename derivation, so independent copies of a project can be
  // pinned to one shared memory regardless of their folder names.
  const configured = getConfiguredProjectName(expanded);
  if (configured) return configured;

  const repoRoot = findGitRepoRoot(expanded);
  const linkedWorktreeRoot = findEnclosingLinkedWorktreeRoot(expanded);
  const isCurrentRepoLinkedWorktree = linkedWorktreeRoot && (!repoRoot || samePath(repoRoot, linkedWorktreeRoot));
  if (isCurrentRepoLinkedWorktree) {
    return path.basename(linkedWorktreeRoot);
  }

  if (repoRoot) {
    if (samePath(expanded, repoRoot)) {
      return path.basename(repoRoot);
    }

    const packageRoot = findNearestPackageRoot(expanded, repoRoot);
    if (!packageRoot && !shouldUseTopLevelSubprojectFallback(repoRoot)) {
      return path.basename(repoRoot);
    }

    const subprojectRoot = packageRoot ?? findTopLevelSubprojectRoot(expanded, repoRoot);
    const relativeBoundary = toProjectPath(path.relative(resolvePath(repoRoot), resolvePath(subprojectRoot)));
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

  // An explicit `.claude-mem.json` name is authoritative: skip worktree
  // compositing so every copy/worktree collapses to the one configured project.
  if (getConfiguredProjectName(expandedCwd)) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const repoRoot = findGitRepoRoot(expandedCwd);
  const linkedWorktreeRoot = findEnclosingLinkedWorktreeRoot(expandedCwd);
  const currentLinkedWorktreeRoot = linkedWorktreeRoot && (!repoRoot || samePath(repoRoot, linkedWorktreeRoot))
    ? linkedWorktreeRoot
    : null;
  const directWorktreeInfo = detectWorktree(expandedCwd);
  const worktreeInfo = directWorktreeInfo.isWorktree
    ? directWorktreeInfo
    : (currentLinkedWorktreeRoot ? detectWorktree(currentLinkedWorktreeRoot) : directWorktreeInfo);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const worktreeName = currentLinkedWorktreeRoot ? path.basename(currentLinkedWorktreeRoot) : cwdProjectName;
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
