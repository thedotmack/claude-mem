import { homedir } from 'os'
import path from 'path';
import { statSync, realpathSync } from 'fs';
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
const CACHE_DEBOUNCE_MS = 100;

export function resetEnvironmentsCache(): void {
  cachedEnvironments = null;
  cachedSettingsMtime = 0;
  lastCacheTime = 0;
}

export function loadEnvironments(): Environment[] {
  const now = Date.now();
  if (cachedEnvironments !== null && now - lastCacheTime < CACHE_DEBOUNCE_MS) {
    return cachedEnvironments;
  }

  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const mtime = statSync(settingsPath).mtimeMs;

    if (cachedEnvironments !== null && mtime === cachedSettingsMtime) {
      lastCacheTime = now;
      return cachedEnvironments;
    }

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const raw = settings.environments;
    cachedEnvironments = raw ? JSON.parse(raw) : [];
    cachedSettingsMtime = mtime;
    lastCacheTime = now;
    return cachedEnvironments;
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

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

  // Check environment matching first
  const envName = matchEnvironment(expanded);
  if (envName) {
    return envName;
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
