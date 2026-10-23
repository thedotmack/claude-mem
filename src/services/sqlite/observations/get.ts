
import { Database } from 'bun:sqlite';
import { projectScopeSql } from '../project-read-keys.js';
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
  // The path is bound once: observation_files indexes both files_read and files_modified.
  const params: (string | number)[] = [...candidatePaths];

  let projectClause = '';
  if (options?.projects?.length) {
    const scope = projectScopeSql('o', options.projects, { includeMerged: true });
    projectClause = `AND ${scope.sql}`;
    params.push(...scope.params);
  }

  let platformClause = '';
  if (options?.platformSource) {
    platformClause = `AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`;
    params.push(normalizePlatformSource(options.platformSource));
  }

  params.push(limit);

  // observation_files holds one row per path an observation reads or modifies,
  // so this is an index seek on the primary key instead of json_each over every
  // observation. The LEFT JOIN to sdk_sessions stays only for the platform filter.
  const stmt = db.prepare(`
    SELECT DISTINCT o.*
    FROM observation_files f
    JOIN observations o ON o.id = f.observation_id
    LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
    WHERE f.path IN (${pathPlaceholders})
    ${projectClause}
    ${platformClause}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(...params) as ObservationRecord[];
}
