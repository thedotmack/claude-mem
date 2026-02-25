/**
 * Project management operations
 * Pure functions for project rename, merge, delete, and row count preview.
 * All mutating operations are transactional across 4 tables.
 */

import type { Database } from './sqlite-compat.js';
import { logger } from '../../utils/logger.js';

/** Row counts per table for a project */
export interface ProjectRowCounts {
  sdk_sessions: number;
  observations: number;
  session_summaries: number;
  context_injections: number;
}

const PROJECT_TABLES = [
  'sdk_sessions',
  'observations',
  'session_summaries',
  'context_injections',
] as const;

type ProjectTable = (typeof PROJECT_TABLES)[number];

// ─── Private helpers ──────────────────────────────────────────────────────────

function countRows(db: Database, table: ProjectTable, project: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE project = ?`).get(project) as {
    count: number;
  };
  return row.count;
}

function projectExistsInAnyTable(db: Database, project: string): boolean {
  return PROJECT_TABLES.some(table => countRows(db, table, project) > 0);
}

/** UPDATE project across all tables, returning the per-table change counts. */
function updateProjectAcrossTables(db: Database, fromProject: string, toProject: string): ProjectRowCounts {
  const result = {} as ProjectRowCounts;
  for (const table of PROJECT_TABLES) {
    result[table] = db.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).run(toProject, fromProject).changes;
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the row counts for a project across all 4 tables.
 * Returns zeros if the project does not exist.
 */
export function getProjectRowCounts(db: Database, project: string): ProjectRowCounts {
  return {
    sdk_sessions: countRows(db, 'sdk_sessions', project),
    observations: countRows(db, 'observations', project),
    session_summaries: countRows(db, 'session_summaries', project),
    context_injections: countRows(db, 'context_injections', project),
  };
}

/**
 * Rename a project across all 4 tables in a single transaction.
 *
 * Throws if:
 * - newName already exists in any table
 * - oldName does not exist in any table
 *
 * Returns the row counts that were updated per table.
 */
export function renameProject(db: Database, oldName: string, newName: string): ProjectRowCounts {
  if (oldName === newName) {
    throw new Error('New name must be different from the current name');
  }

  const counts = db.transaction(() => {
    if (projectExistsInAnyTable(db, newName)) {
      throw new Error(`Target project already exists: ${newName}`);
    }

    if (!projectExistsInAnyTable(db, oldName)) {
      throw new Error(`Source project not found: ${oldName}`);
    }

    return updateProjectAcrossTables(db, oldName, newName);
  })();

  logger.debug('DB', 'Project renamed', { oldName, newName, counts });

  return counts;
}

/**
 * Merge sourceProject into targetProject across all 4 tables in a single transaction.
 * This is the same SQL as rename but with inverted validation:
 * - targetProject MUST exist
 * - sourceProject MUST exist
 *
 * Returns the row counts that were updated (moved from source) per table.
 */
export function mergeProject(
  db: Database,
  sourceProject: string,
  targetProject: string
): ProjectRowCounts {
  if (sourceProject === targetProject) {
    throw new Error('Cannot merge a project into itself');
  }

  const counts = db.transaction(() => {
    if (!projectExistsInAnyTable(db, targetProject)) {
      throw new Error(`Target project not found: ${targetProject}`);
    }

    if (!projectExistsInAnyTable(db, sourceProject)) {
      throw new Error(`Source project not found: ${sourceProject}`);
    }

    return updateProjectAcrossTables(db, sourceProject, targetProject);
  })();

  logger.debug('DB', 'Project merged', { sourceProject, targetProject, counts });

  return counts;
}

/**
 * Delete all rows for a project across all 4 tables in a single transaction.
 *
 * Deletion order: context_injections, session_summaries, observations, sdk_sessions last.
 * Deleting sdk_sessions triggers FK ON DELETE CASCADE for user_prompts and pending_messages.
 * Note: SQLite does NOT fire AFTER DELETE triggers for cascade-deleted rows, so the
 * deprecated user_prompts_fts index will not be updated (acceptable per SessionSearch.ts).
 *
 * Throws if the project does not exist in any table.
 *
 * Returns the row counts that were deleted per table.
 */
export function deleteProject(db: Database, project: string): ProjectRowCounts {
  // Delete child-independent tables first, then sdk_sessions last (triggers FK cascades)
  const deleteOrder: ProjectTable[] = [
    'context_injections',
    'session_summaries',
    'observations',
    'sdk_sessions',
  ];

  const counts = db.transaction(() => {
    if (!projectExistsInAnyTable(db, project)) {
      throw new Error(`Project not found: ${project}`);
    }

    const result = {} as ProjectRowCounts;
    for (const table of deleteOrder) {
      result[table] = db.prepare(`DELETE FROM ${table} WHERE project = ?`).run(project).changes;
    }
    return result;
  })();

  logger.debug('DB', 'Project deleted', { project, counts });

  return counts;
}
