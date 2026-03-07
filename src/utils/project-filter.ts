/**
 * Project Filter Utility
 *
 * Provides glob-based path matching for project exclusion.
 * Supports: ~ (home), * (any chars except /), ** (any path), ? (single char)
 */

import { homedir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Convert a glob pattern to a regular expression
 * Supports: ~ (home dir), * (any non-slash), ** (any path), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~ to home directory
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  // Normalize path separators to forward slashes
  expanded = expanded.replace(/\\/g, '/');

  // Escape regex special characters except * and ?
  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Convert glob patterns to regex:
  // ** matches any path (including /)
  // * matches any characters except /
  // ? matches single character except /
  regex = regex
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  // Temporary placeholder
    .replace(/\*/g, '[^/]*')              // * = any non-slash
    .replace(/\?/g, '[^/]')               // ? = single non-slash
    .replace(/<<<GLOBSTAR>>>/g, '.*');    // ** = anything

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the exclusion patterns
 *
 * @param projectPath - Current working directory (absolute path)
 * @param exclusionPatterns - Comma-separated glob patterns (e.g., "~/kunden/*,/tmp/*")
 * @returns true if path should be excluded
 */
export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  // Normalize cwd path separators
  const normalizedProjectPath = projectPath.replace(/\\/g, '/');

  // Parse comma-separated patterns
  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedProjectPath)) {
        return true;
      }
    } catch {
      // Invalid pattern, skip it
      continue;
    }
  }

  return false;
}

/**
 * Check if a project has been locally disabled via a .claude-mem-disable file.
 * Users can `touch .claude-mem-disable` in any repo to disable claude-mem for that repo.
 */
export function isProjectLocallyDisabled(cwd: string): boolean {
  if (!cwd) return false;
  return existsSync(join(cwd, '.claude-mem-disable'));
}
