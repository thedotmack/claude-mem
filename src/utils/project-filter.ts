
import { homedir } from 'os';
import { basename } from 'path';
import { logger } from './logger.js';

function globToRegex(pattern: string): RegExp {
  let expanded = pattern.startsWith('~')
    ? homedir() + pattern.slice(1)
    : pattern;

  expanded = expanded.replace(/\\/g, '/');

  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  regex = regex
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/<<<GLOBSTAR>>>/g, '.*');

  return new RegExp(`^${regex}$`);
}

/**
 * Returns true when `path` matches any of the supplied glob patterns.
 * Patterns support `*`, `**`, `?`, and a leading `~`. Matches against both the
 * full normalized path and the basename. Used for project exclusion and the
 * skeleton-CLAUDE.md deny-list (#2400).
 */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const pathBasename = basename(normalizedPath);
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedPath) || regex.test(pathBasename)) {
        return true;
      }
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'Invalid glob pattern', { pattern, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }
  return false;
}

/** Comma-separated-pattern form of {@link matchesAnyGlob} for the exclusion setting. */
export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  return matchesAnyGlob(projectPath, (exclusionPatterns ?? '').split(','));
}
