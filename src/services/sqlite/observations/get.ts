/**
 * Observation retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import type { DbAdapter } from '../adapter.js';
import { queryOne, queryAll } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';
import type { GetObservationsByIdsOptions, ObservationSessionRow } from './types.js';

/**
 * Get a single observation by ID
 */
export async function getObservationById(db: DbAdapter, id: number): Promise<ObservationRecord | null> {
  return queryOne<ObservationRecord>(db, `
    SELECT *
    FROM observations
    WHERE id = ?
  `, [id]);
}

/**
 * Get observations by array of IDs with ordering and limit
 */
export async function getObservationsByIds(
  db: DbAdapter,
  ids: number[],
  options: GetObservationsByIdsOptions = {}
): Promise<ObservationRecord[]> {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';

  // Build placeholders for IN clause
  const placeholders = ids.map(() => '?').join(',');
  const params: any[] = [...ids];
  const additionalConditions: string[] = [];

  // Apply project filter
  if (project) {
    additionalConditions.push('project = ?');
    params.push(project);
  }

  // Apply type filter
  if (type) {
    if (Array.isArray(type)) {
      const typePlaceholders = type.map(() => '?').join(',');
      additionalConditions.push(`type IN (${typePlaceholders})`);
      params.push(...type);
    } else {
      additionalConditions.push('type = ?');
      params.push(type);
    }
  }

  // Apply concepts filter
  if (concepts) {
    const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
    const conceptConditions = conceptsList.map(() =>
      'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
    );
    params.push(...conceptsList);
    additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
  }

  // Apply files filter
  if (files) {
    const filesList = Array.isArray(files) ? files : [files];
    const fileConditions = filesList.map(() => {
      return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
    });
    filesList.forEach(file => {
      params.push(`%${file}%`, `%${file}%`);
    });
    additionalConditions.push(`(${fileConditions.join(' OR ')})`);
  }

  const whereClause = additionalConditions.length > 0
    ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
    : `WHERE id IN (${placeholders})`;

  return queryAll<ObservationRecord>(db, `
    SELECT *
    FROM observations
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `, params);
}

/**
 * Get observations for a specific session
 */
export async function getObservationsForSession(
  db: DbAdapter,
  memorySessionId: string
): Promise<ObservationSessionRow[]> {
  return queryAll<ObservationSessionRow>(db, `
    SELECT title, subtitle, type, prompt_number
    FROM observations
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch ASC
  `, [memorySessionId]);
}
