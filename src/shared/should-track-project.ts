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
import { OBSERVER_SESSIONS_DIR, OBSERVER_SESSIONS_PROJECT } from './paths.js';

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
 * Single trust boundary: when the spawning worker set CLAUDE_MEM_INTERNAL=1
 * (see EnvManager.buildIsolatedEnv), the spawned subprocess is an internal
 * claude-mem agent and must never feed the worker — otherwise the observer's
 * own init/continuation/summary prompts end up stored as `user_prompts` and
 * leak into the viewer (meta-observation; see #2118, #2126).
 *
 * The cwd-based OBSERVER_SESSIONS_DIR check stays as belt-and-braces for any
 * pre-env-var spawn path (e.g., user manually launching `claude` inside the
 * observer dir) and for tests that don't exercise the env var.
 */
export function shouldTrackProject(cwd: string): boolean {
  if (process.env.CLAUDE_MEM_INTERNAL === '1') return false;
  if (!cwd) return true;
  // path.relative handles separator differences (Windows '\\' vs POSIX '/')
  // and trailing-slash variance, which a literal startsWith would miss.
  if (isWithin(cwd, OBSERVER_SESSIONS_DIR)) {
    return false;
  }
  const settings = loadFromFileOnce();
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}

/**
 * Shared predicate: should a row tagged with `project` be emitted to user-facing
 * surfaces (SSE stream, viewer UI list)? Used by both PaginationHelper SQL
 * filters and SSEBroadcaster payload filters so they can never drift.
 *
 * Internal claude-mem rows (project === OBSERVER_SESSIONS_PROJECT) are hidden
 * from the unfiltered list view and the live SSE stream. They remain queryable
 * by id and by explicit `project=observer-sessions` filter for diagnostics.
 */
export function shouldEmitProjectRow(project: string | null | undefined): boolean {
  if (!project) return true;
  return project !== OBSERVER_SESSIONS_PROJECT;
}
