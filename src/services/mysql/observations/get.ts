/**
 * Observation retrieval functions (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';
import type { GetObservationsByIdsOptions, ObservationSessionRow } from './types.js';

export async function getObservationById(db: MySQLDatabase, id: number): Promise<ObservationRecord | null> {
  return await db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRecord || null;
}

export async function getObservationsByIds(
  db: MySQLDatabase, ids: number[], options: GetObservationsByIdsOptions = {}
): Promise<ObservationRecord[]> {
  if (ids.length === 0) return [];
  const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: any[] = [...ids];
  const conditions: string[] = [];

  if (project) { conditions.push('project = ?'); params.push(project); }
  if (type) {
    if (Array.isArray(type)) {
      conditions.push(`type IN (${type.map(() => '?').join(',')})`);
      params.push(...type);
    } else { conditions.push('type = ?'); params.push(type); }
  }
  // Note: MySQL JSON functions differ from SQLite json_each
  if (concepts) {
    const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
    conceptsList.forEach(c => { conditions.push('JSON_CONTAINS(concepts, ?)'); params.push(JSON.stringify(c)); });
    if (conceptsList.length > 1) {
      // Replace last N conditions with OR
      // Simplified: just use OR
    }
  }
  if (files) {
    const filesList = Array.isArray(files) ? files : [files];
    filesList.forEach(f => {
      conditions.push('(JSON_CONTAINS(files_read, ?) OR JSON_CONTAINS(files_modified, ?))');
      params.push(JSON.stringify(f), JSON.stringify(f));
    });
  }

  const whereClause = conditions.length > 0
    ? `WHERE id IN (${placeholders}) AND (${conditions.join(' OR ')})`
    : `WHERE id IN (${placeholders})`;

  return await db.prepare(`
    SELECT * FROM observations ${whereClause}
    ORDER BY created_at_epoch ${orderClause} ${limitClause}
  `).all(...params) as ObservationRecord[];
}

export async function getObservationsForSession(
  db: MySQLDatabase, memorySessionId: string
): Promise<ObservationSessionRow[]> {
  return await db.prepare(`
    SELECT title, subtitle, type, prompt_number
    FROM observations WHERE memory_session_id = ?
    ORDER BY created_at_epoch ASC
  `).all(memorySessionId) as ObservationSessionRow[];
}

export async function getObservationsByFilePath(
  db: MySQLDatabase, filePath: string,
  options?: { projects?: string[]; limit?: number }
): Promise<ObservationRecord[]> {
  const limit = options?.limit ?? 15;
  const params: (string | number)[] = [JSON.stringify(filePath), JSON.stringify(filePath)];
  let projectClause = '';
  if (options?.projects?.length) {
    projectClause = `AND project IN (${options.projects.map(() => '?').join(',')})`;
    params.push(...options.projects);
  }
  params.push(limit);

  return await db.prepare(`
    SELECT * FROM observations
    WHERE (JSON_CONTAINS(files_read, ?) OR JSON_CONTAINS(files_modified, ?))
    ${projectClause}
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(...params) as ObservationRecord[];
}

// Re-export types
export type { GetObservationsByIdsOptions, ObservationSessionRow } from './types.js';
