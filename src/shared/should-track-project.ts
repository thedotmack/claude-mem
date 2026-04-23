/**
 * Single answer to "should this hook run for this cwd?"
 *
 * Plan 05 Phase 5 (PATHFINDER-2026-04-22): three handlers (observation,
 * session-init, file-context) each duplicated the
 * `loadFromFileOnce() → isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)`
 * pair. This module is the only entry point for that question; handlers call
 * `shouldTrackProject(cwd)` and route through here.
 *
 * One helper, N callers (Principle 6). After this module lands, no handler
 * references `isProjectExcluded` directly — the import lives only here.
 */

import { isProjectExcluded } from '../utils/project-filter.js';
import { loadFromFileOnce } from './hook-settings.js';

/**
 * @returns true when the project at `cwd` is NOT excluded from claude-mem
 *          tracking, i.e., the hook should proceed; false when the project
 *          matches one of the exclusion globs.
 */
export function shouldTrackProject(cwd: string): boolean {
  if (!cwd) return true;
  const settings = loadFromFileOnce();
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}
