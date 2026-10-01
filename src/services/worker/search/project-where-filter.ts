import type { SessionStore } from '../../sqlite/SessionStore.js';

/**
 * Chroma where-filter for one project: the row's own key or the project it
 * was merged into, in every stored spelling of the name. SQLite reads compare
 * project and merged_into_project case-insensitively (#3531, #3641); Chroma
 * compares exactly, so it is handed each case variant that exists. Every
 * Chroma search path scopes a project through this one builder, so semantic
 * results never disagree with the SQLite rows they are hydrated from.
 */
export function buildProjectWhereFilter(
  sessionStore: Pick<SessionStore, 'getProjectKeyCaseVariants'>,
  project: string
): Record<string, unknown> {
  const variants = sessionStore.getProjectKeyCaseVariants(project);
  const match = variants.length === 1 ? variants[0] : { $in: variants };
  return {
    $or: [
      { project: match },
      { merged_into_project: match }
    ]
  };
}
