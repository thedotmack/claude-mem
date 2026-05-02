import type { Database } from 'bun:sqlite';
import type { SessionSummary } from './types.js';

export function getSummaryForSession(
  db: Database,
  memorySessionId: string
): SessionSummary | null {
  const stmt = db.prepare(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at,
      created_at_epoch
    FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `);

  return (stmt.get(memorySessionId) as SessionSummary | undefined) || null;
}
