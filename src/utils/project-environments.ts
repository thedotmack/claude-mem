import { realpathSync } from 'fs';
import { matchesAnyGlob } from './project-filter.js';
import { logger } from './logger.js';

/**
 * A named environment: several directories that share one memory bucket
 * (CLAUDE_MEM_PROJECT_ENVIRONMENTS). Patterns use the same glob rules as
 * CLAUDE_MEM_EXCLUDED_PROJECTS (`*`, `**`, `?`, leading `~`; a pattern also
 * matches a folder's name on its own), and `dir/**` covers `dir` itself.
 */
export interface ProjectEnvironment {
  name: string;
  patterns: string[];
}

/**
 * Parse the setting. settings.json may hold it as a JSON string or as a native
 * JSON array, so both are accepted. Anything invalid is skipped with a warning,
 * so a typo falls back to the ordinary naming rules instead of breaking capture.
 */
export function parseProjectEnvironments(raw: unknown): ProjectEnvironment[] {
  let value = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'CLAUDE_MEM_PROJECT_ENVIRONMENTS is not valid JSON; ignoring it', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      logger.warn('PROJECT_NAME', 'CLAUDE_MEM_PROJECT_ENVIRONMENTS must be an array; ignoring it', {});
    }
    return [];
  }

  const environments: ProjectEnvironment[] = [];
  for (const entry of value as Array<{ name?: unknown; patterns?: unknown }>) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const patterns = Array.isArray(entry?.patterns)
      ? entry.patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')
      : [];
    if (!name || patterns.length === 0) {
      logger.warn('PROJECT_NAME', 'Ignoring a project environment without a name or patterns', { name });
      continue;
    }
    environments.push({ name, patterns });
  }
  return environments;
}

function realpathOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The environment `dir` belongs to, or null. Both the path as given and its
 * realpath are tried, so a symlinked home or checkout matches patterns written
 * either way; the trailing-slash form lets `dir/**` match `dir` itself.
 */
export function matchProjectEnvironment(dir: string, environments: ProjectEnvironment[]): string | null {
  if (environments.length === 0) return null;
  const candidates = [...new Set([dir, realpathOrSelf(dir)])]
    .flatMap(candidate => [candidate, `${candidate.replace(/[\\/]+$/, '')}/`]);
  for (const environment of environments) {
    if (candidates.some(candidate => matchesAnyGlob(candidate, environment.patterns))) {
      return environment.name;
    }
  }
  return null;
}
