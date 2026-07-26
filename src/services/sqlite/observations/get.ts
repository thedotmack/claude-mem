
import { Database } from 'bun:sqlite';
import type { ObservationRecord } from '../../../types/database.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../../shared/platform-source.js';
import { logger } from '../../../utils/logger.js';

export function getObservationsByFilePath(
  db: Database,
  filePath: string | string[],
  options?: { projects?: string[]; limit?: number; platformSource?: string }
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
    logger.debug('DB', 'Skipping observation file lookup with no candidate paths');
    return [];
  }

  const pathPlaceholders = candidatePaths.map(() => '?').join(',');
  // Params order mirrors the two json_each subqueries (files_read, then files_modified).
  const params: (string | number)[] = [...candidatePaths, ...candidatePaths];

  let projectClause = '';
  if (options?.projects?.length) {
    const placeholders = options.projects.map(() => '?').join(',');
    projectClause = `AND o.project IN (${placeholders})`;
    params.push(...options.projects);
  }

  let platformClause = '';
  if (options?.platformSource) {
    platformClause = `AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`;
    params.push(normalizePlatformSource(options.platformSource));
  }

  params.push(limit);

  const stmt = db.prepare(`
    SELECT o.*
    FROM observations o
    LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
    WHERE (
      (o.files_read LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value IN (${pathPlaceholders})))
      OR (o.files_modified LIKE '[%' AND EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value IN (${pathPlaceholders})))
    )
    ${projectClause}
    ${platformClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(...params) as ObservationRecord[];
}
