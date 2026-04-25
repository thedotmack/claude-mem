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

import { relative, isAbsolute } from 'path';
import { isProjectExcluded } from '../utils/project-filter.js';
import { loadFromFileOnce } from './hook-settings.js';
import { OBSERVER_SESSIONS_DIR } from './paths.js';

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * @returns true when the project at `cwd` is NOT excluded from claude-mem
 *          tracking, i.e., the hook should proceed; false when the project
 *          matches one of the exclusion globs.
 *
 * Hard-excludes OBSERVER_SESSIONS_DIR: the SDK agent spawns Claude Code with
 * that cwd, and its hooks must never feed the worker — otherwise the observer's
 * own init/continuation/summary prompts end up stored as `user_prompts` and
 * leak into the viewer (meta-observation).
 */
export function shouldTrackProject(cwd: string): boolean {
  if (!cwd) return true;
  // path.relative handles separator differences (Windows '\\' vs POSIX '/')
  // and trailing-slash variance, which a literal startsWith would miss.
  if (isWithin(cwd, OBSERVER_SESSIONS_DIR)) {
    return false;
  }
  const settings = loadFromFileOnce();
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}
