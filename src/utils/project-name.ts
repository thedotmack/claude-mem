import path from 'path';
import { logger } from './logger.js';

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  // Allow manual project name override via env var
  if (process.env.CLAUDE_MEM_PROJECT) {
    return process.env.CLAUDE_MEM_PROJECT;
  }

  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    // Extract drive letter on Windows, or use 'root' on Unix
    const isWindows = process.platform === 'win32';
    if (isWindows && cwd.match(/^[A-Z]:\\/i)) {
      const driveLetter = cwd[0].toUpperCase();
      const projectName = `drive-${driveLetter}`;
      logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
      return projectName;
    } else {
      logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
      return 'unknown-project';
    }
  }

  return basename;
}
