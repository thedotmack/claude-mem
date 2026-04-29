
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SessionFilesResult } from './types.js';

export function parseFileList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [value];
  }
}

export function getFilesForSession(
  db: Database,
  memorySessionId: string
): SessionFilesResult {
  const stmt = db.prepare(`
    SELECT files_read, files_modified
    FROM observations
    WHERE memory_session_id = ?
  `);

  const rows = stmt.all(memorySessionId) as Array<{
    files_read: string | null;
    files_modified: string | null;
  }>;

  const filesReadSet = new Set<string>();
  const filesModifiedSet = new Set<string>();

  for (const row of rows) {
    parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

    parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
  }

  return {
    filesRead: Array.from(filesReadSet),
    filesModified: Array.from(filesModifiedSet)
  };
}
