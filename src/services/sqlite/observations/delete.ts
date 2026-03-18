import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface DeleteObservationsResult {
  deleted: number[];
  notFound: number[];
}

/**
 * Delete observations by IDs.
 * Checks existence first to report which IDs were actually deleted
 * vs not found. FTS cleanup is automatic via the observations_ad trigger.
 */
export function deleteObservations(
  db: Database,
  ids: number[]
): DeleteObservationsResult {
  if (ids.length === 0) return { deleted: [], notFound: [] };

  // Find which IDs exist
  const placeholders = ids.map(() => '?').join(',');
  const existing = db
    .prepare(`SELECT id FROM observations WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number }[];

  const existingIds = new Set(existing.map(row => row.id));
  const deleted = ids.filter(id => existingIds.has(id));
  const notFound = ids.filter(id => !existingIds.has(id));

  // Delete existing observations
  if (deleted.length > 0) {
    const deletePlaceholders = deleted.map(() => '?').join(',');
    db.prepare(`DELETE FROM observations WHERE id IN (${deletePlaceholders})`)
      .run(...deleted);
    logger.debug('DELETE', `Deleted ${deleted.length} observation(s) | ids=${deleted.join(',')}`);
  }

  return { deleted, notFound };
}
