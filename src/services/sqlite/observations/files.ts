
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
