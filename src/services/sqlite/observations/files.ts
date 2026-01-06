/**
 * Session file retrieval functions
 * Extracted from SessionStore.ts for modular organization
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SessionFilesResult } from './types.js';

/**
 * Get aggregated files from all observations for a session
 */
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
    // Parse files_read
    if (row.files_read) {
      const files = JSON.parse(row.files_read);
      if (Array.isArray(files)) {
        files.forEach(f => filesReadSet.add(f));
      }
    }

    // Parse files_modified
    if (row.files_modified) {
      const files = JSON.parse(row.files_modified);
      if (Array.isArray(files)) {
        files.forEach(f => filesModifiedSet.add(f));
      }
    }
  }

  return {
    filesRead: Array.from(filesReadSet),
    filesModified: Array.from(filesModifiedSet)
  };
}
