
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { ObservationRecord } from '../../../types/database.js';

export function getObservationsByFilePath(
  db: Database,
  filePath: string | string[],
  options?: { projects?: string[]; limit?: number }
): ObservationRecord[] {
  const rawLimit = options?.limit;
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
    ? Math.min(rawLimit as number, 100)
    : 15;

  // #2691 — PreToolUse:Read and PostToolUse can disagree on the stored path
  // form (absolute vs project-root-relative vs cwd-relative). Accept multiple
  // candidate path forms and match observations whose files_read/files_modified
  // contain ANY of them, so context injection keyed on path is consistent
  // across the two events. De-duplicate to keep the IN() clause minimal.
  const candidatePaths = Array.from(
    new Set((Array.isArray(filePath) ? filePath : [filePath]).filter(p => typeof p === 'string' && p.length > 0))
  );
  if (candidatePaths.length === 0) {
    return [];
  }

  const pathPlaceholders = candidatePaths.map(() => '?').join(',');
  // Params order mirrors the two json_each subqueries (files_read, then files_modified).
  const params: (string | number)[] = [...candidatePaths, ...candidatePaths];

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
      (files_read LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_read) WHERE value IN (${pathPlaceholders})))
      OR (files_modified LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value IN (${pathPlaceholders})))
    )
    ${projectClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(...params) as ObservationRecord[];
}
