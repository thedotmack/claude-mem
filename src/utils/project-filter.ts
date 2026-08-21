
import { basename } from 'path';
import { expandHome } from '../shared/paths.js';
import { logger } from './logger.js';

function globToRegex(pattern: string): RegExp {
  // Separators first, then home expansion. A pattern written on Windows as `~\projects\secret`
  // is home-relative, but `expandHome` only recognises `~` and `~/` — resolving another user's
  // home is deliberately out of its scope, so it cannot widen its `~` check without ambiguity.
  // Expanding before normalising left that pattern as a literal `~/projects/secret`, which
  // matches no absolute path, so a configured exclusion silently stopped excluding.
  let expanded = expandHome(pattern.replace(/\\/g, '/'));

  // Again on the way out: on Windows `homedir()` itself returns backslashes, so the
  // expanded path needs normalising even when the pattern arrived POSIX-form.
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
 * Returns true when `folderPath` matches any of the supplied glob patterns.
 * Patterns support `*`, `**`, `?`, and a leading `~`. Matches against both the
 * full normalized path and the basename. Reuses the same glob semantics as
 * project exclusion. Used by the skeleton-CLAUDE.md deny-list (#2400).
 */
export function matchesAnyGlob(folderPath: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const normalizedPath = folderPath.replace(/\\/g, '/');
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

export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  const normalizedProjectPath = projectPath.replace(/\\/g, '/');
  const projectBasename = basename(normalizedProjectPath);

  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedProjectPath) || regex.test(projectBasename)) {
        return true;
      }
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'Invalid exclusion pattern', { pattern, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }

  return false;
}
