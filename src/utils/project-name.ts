import path from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../shared/SettingsDefaultsManager.js';

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
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

/**
 * Convert a glob pattern to a RegExp
 * Supports: * (any chars), ? (single char)
 *
 * @param pattern - Glob pattern (e.g., "claude-analysis-*")
 * @returns RegExp that matches the pattern
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars (except * and ?)
    .replace(/\*/g, '.*')                    // * → match any characters
    .replace(/\?/g, '.');                    // ? → match single character
  return new RegExp(`^${escaped}$`);
}

/**
 * Check if a pattern contains glob wildcards
 */
function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Check if a project is excluded from claude-mem
 * Uses CLAUDE_MEM_EXCLUDE_PROJECTS setting (comma-separated list)
 * Supports exact matches and glob patterns (*, ?)
 *
 * Examples:
 *   - "claude-mem" → exact match
 *   - "claude-analysis-*" → matches claude-analysis-abc123, claude-analysis-xyz
 *   - "test-?" → matches test-1, test-a, but not test-12
 *
 * @param project - Project name to check
 * @param settings - Optional pre-loaded settings (loads from file if not provided)
 * @returns true if project should be excluded
 */
export function isProjectExcluded(project: string, settings?: SettingsDefaults): boolean {
  const settingsToUse = settings ?? SettingsDefaultsManager.loadFromFile(
    path.join(homedir(), '.claude-mem', 'settings.json')
  );

  const excludeList = settingsToUse.CLAUDE_MEM_EXCLUDE_PROJECTS;
  if (!excludeList || excludeList.trim() === '') {
    return false;
  }

  const patterns = excludeList.split(',').map(p => p.trim()).filter(Boolean);

  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      // Glob pattern match
      const regex = globToRegex(pattern);
      if (regex.test(project)) {
        return true;
      }
    } else {
      // Exact match
      if (pattern === project) {
        return true;
      }
    }
  }

  return false;
}
