import { homedir } from 'os'
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { paths } from '../shared/paths.js';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

const USE_GIT_ROOT_SETTING = 'CLAUDE_MEM_USE_GIT_ROOT';
let cachedUseGitRootProjectName: boolean | undefined;

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isEnabledSetting(value: unknown): boolean {
  return value === 'true' || value === true;
}

function useGitRootProjectName(): boolean {
  const envValue = process.env[USE_GIT_ROOT_SETTING];
  if (envValue !== undefined) {
    return isEnabledSetting(envValue);
  }

  if (cachedUseGitRootProjectName !== undefined) {
    return cachedUseGitRootProjectName;
  }

  try {
    const settingsPath = paths.settings();
    if (!existsSync(settingsPath)) {
      cachedUseGitRootProjectName = false;
      return cachedUseGitRootProjectName;
    }

    const parsed = asRecord(JSON.parse(readFileSync(settingsPath, 'utf-8')));
    if (!parsed) {
      cachedUseGitRootProjectName = false;
      return cachedUseGitRootProjectName;
    }

    const nestedEnv = asRecord(parsed.env);
    const settings = nestedEnv ?? parsed;
    cachedUseGitRootProjectName = isEnabledSetting(settings[USE_GIT_ROOT_SETTING]);
    return cachedUseGitRootProjectName;
  } catch (error: unknown) {
    logger.debug(
      'PROJECT_NAME',
      'Failed to read git-root project-name setting, using basename mode',
      {},
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

function findNearestGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    const gitMarker = path.join(current, '.git');

    try {
      const stat = statSync(gitMarker);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(
          'PROJECT_NAME',
          'Failed checking .git marker while resolving project root',
          { cwd: startPath, gitMarker },
          error
        );
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveProjectPath(cwd: string): string {
  const expanded = expandTilde(cwd);
  if (!useGitRootProjectName()) {
    return expanded;
  }

  return findNearestGitRoot(expanded) ?? expanded;
}

function getProjectNameFromPath(projectPath: string, originalCwd: string): string {
  const basename = path.basename(projectPath);

  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = originalCwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd: originalCwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd: originalCwd });
    return 'unknown-project';
  }

  return basename;
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const projectPath = resolveProjectPath(cwd);
  return getProjectNameFromPath(projectPath, cwd);
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  if (!cwd || cwd.trim() === '') {
    const projectName = getProjectName(cwd);
    return { primary: projectName, parent: null, isWorktree: false, allProjects: [projectName] };
  }

  const projectPath = resolveProjectPath(cwd);
  const cwdProjectName = getProjectNameFromPath(projectPath, cwd);
  const worktreeInfo = detectWorktree(projectPath);

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
