import path from 'path';
import { logger } from './logger.js';
import { resolveProjectIdentity } from './git-project-identity.js';

/**
 * Extract project name from working directory path
 *
 * Uses git-aware identity cascade:
 * 1. .claude-mem config file in repo root (explicit override)
 * 2. Git remote origin URL (normalized)
 * 3. Git repo root basename
 * 4. Folder basename (fallback for non-git directories)
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  return resolveProjectIdentity(cwd).name;
}

/**
 * Get folder basename only (legacy behavior)
 * Use this when git-aware identity is explicitly not wanted
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Folder basename or "unknown-project" if extraction fails
 */
export function getFolderBasename(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    return 'unknown-project';
  }

  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        return `drive-${driveMatch[1].toUpperCase()}`;
      }
    }
    return 'unknown-project';
  }

  return basename;
}
