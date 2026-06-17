/**
 * Recent observation retrieval (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import type { RecentObservationRow, AllRecentObservationRow } from './types.js';

export async function getRecentObservations(
  db: MySQLDatabase, project: string, limit: number = 20
): Promise<RecentObservationRow[]> {
  return await db.prepare(`
    SELECT type, \`text\`, prompt_number, created_at
    FROM observations WHERE project = ?
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(project, limit) as RecentObservationRow[];
}

export async function getAllRecentObservations(
  db: MySQLDatabase, limit: number = 100
): Promise<AllRecentObservationRow[]> {
  return await db.prepare(`
    SELECT id, type, title, subtitle, \`text\`, project, prompt_number, created_at, created_at_epoch
    FROM observations ORDER BY created_at_epoch DESC LIMIT ?
  `).all(limit) as AllRecentObservationRow[];
}
