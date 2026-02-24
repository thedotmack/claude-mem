/**
 * Observation read analytics
 *
 * Tracks how often observations are fetched/read by Claude.
 * All functions are fire-and-forget safe (silently no-op on error).
 */

import { Database } from 'bun:sqlite';
import type { ObservationRecord } from '../../../types/database.js';

/**
 * Increment read_count and update last_read_at for the given observation IDs.
 * Safe to call fire-and-forget — errors are silently swallowed.
 */
export function incrementReadCount(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  try {
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    db.prepare(
      `UPDATE observations SET read_count = read_count + 1, last_read_at = ? WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  } catch {
    // Silently ignore — column may not exist yet on old DBs mid-migration
  }
}

export interface MostReadRow {
  id: number;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  read_count: number;
  last_read_at: number | null;
  discovery_tokens: number;
  created_at: string;
}

/**
 * Return the most-read observations, ordered by read_count descending.
 */
export function getMostReadObservations(
  db: Database,
  limit = 20,
  project?: string
): MostReadRow[] {
  const params: (string | number)[] = [];
  let where = 'WHERE read_count > 0';
  if (project) {
    where += ' AND project = ?';
    params.push(project);
  }
  params.push(limit);

  return db.prepare(`
    SELECT id, project, type, title, subtitle, read_count, last_read_at,
           discovery_tokens, created_at
    FROM observations
    ${where}
    ORDER BY read_count DESC
    LIMIT ?
  `).all(...params) as MostReadRow[];
}
