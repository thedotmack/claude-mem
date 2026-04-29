
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';
import type { GetObservationsByIdsOptions, ObservationSessionRow } from './types.js';

export function getObservationById(db: Database, id: number): ObservationRecord | null {
  const stmt = db.prepare(`
    SELECT *
    FROM observations
    WHERE id = ?
  `);

  return stmt.get(id) as ObservationRecord | undefined || null;
}

export function getObservationsByIds(
  db: Database,
  ids: number[],
  options: GetObservationsByIdsOptions = {}
): ObservationRecord[] {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';

  const placeholders = ids.map(() => '?').join(',');
  const params: any[] = [...ids];
  const additionalConditions: string[] = [];

  if (project) {
    additionalConditions.push('project = ?');
    params.push(project);
  }

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

  if (concepts) {
    const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
    const conceptConditions = conceptsList.map(() =>
      'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
    );
    params.push(...conceptsList);
    additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
  }

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

  const stmt = db.prepare(`
    SELECT *
    FROM observations
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `);

  return stmt.all(...params) as ObservationRecord[];
}

export function getObservationsForSession(
  db: Database,
  memorySessionId: string
): ObservationSessionRow[] {
  const stmt = db.prepare(`
    SELECT title, subtitle, type, prompt_number
    FROM observations
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch ASC
  `);

  return stmt.all(memorySessionId) as ObservationSessionRow[];
}

export function getObservationsByFilePath(
  db: Database,
  filePath: string,
  options?: { projects?: string[]; limit?: number }
): ObservationRecord[] {
  const rawLimit = options?.limit;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
    ? Math.min(rawLimit as number, 100)
    : 15;
  const params: (string | number)[] = [filePath, filePath];

  let projectClause = '';
  if (options?.projects?.length) {
    const placeholders = options.projects.map(() => '?').join(',');
    projectClause = `AND project IN (${placeholders})`;
    params.push(...options.projects);
  }

  params.push(limit);

  const stmt = db.prepare(`
    SELECT *
    FROM observations
    WHERE (
      (files_read LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_read) WHERE value = ?))
      OR (files_modified LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value = ?))
    )
    ${projectClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(...params) as ObservationRecord[];
}
