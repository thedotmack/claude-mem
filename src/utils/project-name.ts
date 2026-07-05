import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

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
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to basename', { dir }, err);
    return null;
  }
}

function normalizedKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function basenameKey(sourcePath: string, originalPath: string): string {
  const basename = path.basename(sourcePath);
  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = originalPath.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd: originalPath, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd: originalPath });
    return 'unknown-project';
  }

  return normalizedKey(basename);
}

function repoRelativeKey(repoRoot: string, cwd: string): string | null {
  const relative = path.relative(repoRoot, cwd);
  const normalized = normalizedKey(relative);
  if (!normalized || normalized === '.') return null;
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function existingDirectory(candidate: string): string | null {
  try {
    const stat = statSync(candidate);
    return stat.isDirectory() ? candidate : path.dirname(candidate);
  } catch {
    return null;
  }
}

function readProjectOverride(configPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      projectName?: unknown;
      project_name?: unknown;
    };
    const raw = typeof parsed.projectName === 'string'
      ? parsed.projectName
      : typeof parsed.project_name === 'string'
        ? parsed.project_name
        : null;
    const normalized = raw ? normalizedKey(raw) : '';
    return normalized || null;
  } catch (error: unknown) {
    logger.warn(
      'PROJECT_NAME',
      'Failed to parse .claude-mem.json project override',
      { configPath },
      error instanceof Error ? error : new Error(String(error))
    );
    return null;
  }
}

function findProjectOverride(cwd: string, repoRoot: string | null): string | null {
  let current = existingDirectory(cwd);
  if (!current) return null;

  const stopAt = repoRoot ?? path.parse(current).root;
  while (true) {
    const configPath = path.join(current, '.claude-mem.json');
    if (existsSync(configPath)) {
      const override = readProjectOverride(configPath);
      if (override) return override;
    }

    if (current === stopAt) return null;
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function uniqueProjects(projects: Array<string | null | undefined>): string[] {
  return Array.from(new Set(projects.filter((project): project is string => !!project)));
}

export function getProjectName(cwd: string | null | undefined): string {
  return getProjectContext(cwd).primary;
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
  cwdKey: string;
  gitRootKey: string | null;
  repoRelativeKey: string | null;
  userOverride: string | null;
  aliases: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    const primary = 'unknown-project';
    return {
      primary,
      parent: null,
      isWorktree: false,
      allProjects: [primary],
      cwdKey: primary,
      gitRootKey: null,
      repoRelativeKey: null,
      userOverride: null,
      aliases: []
    };
  }

  const expandedCwd = expandTilde(cwd);
  const cwdKey = basenameKey(expandedCwd, cwd);
  const repoRoot = findGitRepoRoot(expandedCwd);
  const userOverride = findProjectOverride(expandedCwd, repoRoot);

  if (!repoRoot) {
    const directWorktreeInfo = detectWorktree(expandedCwd);
    if (directWorktreeInfo.isWorktree && directWorktreeInfo.parentProjectName) {
      const computedPrimary = `${directWorktreeInfo.parentProjectName}/${cwdKey}`;
      const primary = userOverride ?? computedPrimary;
      const allProjects = uniqueProjects([directWorktreeInfo.parentProjectName, computedPrimary, userOverride]);
      return {
        primary,
        parent: directWorktreeInfo.parentProjectName,
        isWorktree: true,
        allProjects,
        cwdKey,
        gitRootKey: computedPrimary,
        repoRelativeKey: null,
        userOverride,
        aliases: allProjects.filter(project => project !== primary)
      };
    }

    const primary = userOverride ?? cwdKey;
    const allProjects = uniqueProjects([cwdKey, userOverride]);
    return {
      primary,
      parent: null,
      isWorktree: false,
      allProjects,
      cwdKey,
      gitRootKey: null,
      repoRelativeKey: null,
      userOverride,
      aliases: allProjects.filter(project => project !== primary)
    };
  }

  const gitRootLeaf = basenameKey(repoRoot, repoRoot);
  const worktreeInfo = detectWorktree(repoRoot);
  const isWorktree = worktreeInfo.isWorktree && !!worktreeInfo.parentProjectName;
  const parent = isWorktree ? worktreeInfo.parentProjectName : null;
  const gitRootKey = isWorktree ? `${parent}/${gitRootLeaf}` : gitRootLeaf;
  const relativeKey = repoRelativeKey(repoRoot, expandedCwd);
  const computedPrimary = relativeKey ? `${gitRootKey}/${relativeKey}` : gitRootKey;
  const primary = userOverride ?? computedPrimary;
  const allProjects = uniqueProjects([parent, gitRootKey, computedPrimary, userOverride]);

  return {
    primary,
    parent,
    isWorktree,
    allProjects,
    cwdKey,
    gitRootKey,
    repoRelativeKey: relativeKey,
    userOverride,
    aliases: allProjects.filter(project => project !== primary)
  };
}
