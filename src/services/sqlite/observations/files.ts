
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export function parseFileList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (error) {
    logger.debug('DB', 'File list is not JSON; treating value as a single path', { value }, error instanceof Error ? error : new Error(String(error)));
    return [value];
  }
}

/** Paths a stored JSON column actually contains. Only a JSON array of strings
 * counts, matching json_each over json_type = 'array' — a JSON string, object,
 * or scalar is not a file list and must not become a lookup hit. */
export function parseIndexedFilePaths(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * Re-point one observation's index rows at what its raw JSON file columns
 * currently hold. DELETE-then-INSERT so an UPDATE never leaves the previous
 * revision's paths searchable. Call it inside the same transaction as the
 * observation row write it mirrors — a row committed without its mappings is
 * permanently unsearchable by file (the import replay match skips the row and
 * the v68 migration is already stamped, so nothing repairs it later).
 */
export function replaceObservationFileIndex(
  db: Database,
  observationId: number,
  filesRead: string | null | undefined,
  filesModified: string | null | undefined,
): void {
  db.prepare('DELETE FROM observation_files WHERE observation_id = ?').run(observationId);
  const paths = new Set([...parseIndexedFilePaths(filesRead), ...parseIndexedFilePaths(filesModified)]);
  if (paths.size === 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)');
  for (const path of paths) insert.run(path, observationId);
}
