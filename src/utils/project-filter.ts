/**
 * Project Filter Utility
 *
 * Provides glob-based path matching for project exclusion.
 * Supports: ~ (home), * (any chars except /), ** (any path), ? (single char)
 */

import { homedir } from 'os';

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
 * @param cwd - Current working directory (absolute path)
 * @param patterns - Comma-separated glob patterns (e.g., "~/kunden/*,/tmp/*")
 * @returns true if path should be excluded
 */
export function isProjectExcluded(cwd: string, patterns: string): boolean {
  if (!patterns || !patterns.trim()) {
    return false;
  }

  // Normalize cwd path separators
  const normalizedCwd = cwd.replace(/\\/g, '/');

  // Parse comma-separated patterns
  const patternList = patterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedCwd)) {
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
 * Parse exclusion patterns from settings string
 * @param patterns - Comma-separated patterns
 * @returns Array of individual patterns
 */
export function parseExclusionPatterns(patterns: string): string[] {
  if (!patterns || !patterns.trim()) {
    return [];
  }

  return patterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
}
