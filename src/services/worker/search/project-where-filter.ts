import type { SessionStore } from '../../sqlite/SessionStore.js';
import { scopedProjects } from '../../sqlite/project-read-keys.js';

/**
 * Every key a search for `project` and `projects` reads: the requested keys
 * (a checkout's current key plus the ones it wrote under before a re-key,
 * gate P2-5), their stored spellings, and the projects merged into them, one
 * hop (gate P2-4). `projects` is a list, or comma-separated from a query
 * string. Empty when the search is not scoped to a project.
 */
export function projectReadKeysFor(
  sessionStore: Pick<SessionStore, 'getProjectReadKeys'>,
  project: unknown,
  projects: unknown
): string[] {
  const listed = typeof projects === 'string'
    ? projects.split(',')
    : Array.isArray(projects) ? projects.filter((entry): entry is string => typeof entry === 'string') : [];
  const requested = scopedProjects({ projects: [...(typeof project === 'string' ? [project] : []), ...listed] });
  return requested.length > 0 ? sessionStore.getProjectReadKeys(requested) : [];
}

/**
 * Chroma where-filter for a set of read keys (see projectReadKeysFor): the
 * row's own key or the project it was merged into. Chroma compares metadata
 * exactly, so the keys already list every stored spelling (#3531). Every
 * Chroma search path scopes projects through this one filter, so semantic
 * results never disagree with the SQLite rows they are hydrated from.
 */
export function buildProjectWhereFilter(readKeys: string[]): Record<string, unknown> {
  const match = readKeys.length === 1 ? readKeys[0] : { $in: readKeys };
  return {
    $or: [
      { project: match },
      { merged_into_project: match }
    ]
  };
}
