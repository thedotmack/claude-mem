/**
 * Recent observation retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { RecentObservationRow, AllRecentObservationRow } from './types.js';

/**
 * Get recent observations for a project
 */
export function getRecentObservations(
  db: Database,
  project: string,
  limit: number = 20,
  branch?: string
): RecentObservationRow[] {
  const branchClause = branch ? 'AND branch = ?' : '';
  const sql = `
    SELECT type, text, prompt_number, created_at
    FROM observations
    WHERE project = ? ${branchClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `;
  const params = branch ? [project, branch, limit] : [project, limit];

  return db.prepare(sql).all(...params) as RecentObservationRow[];
}

/**
 * Get recent observations across all projects (for web UI)
 */
export function getAllRecentObservations(
  db: Database,
  limit: number = 100
): AllRecentObservationRow[] {
  const stmt = db.prepare(`
    SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
    FROM observations
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(limit) as AllRecentObservationRow[];
}
