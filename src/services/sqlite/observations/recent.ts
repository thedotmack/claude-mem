
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export function getFirstObservationCreatedAt(db: Database, project?: string): string | null {
  // When a project is supplied, scope to that project's earliest row — including
  // worktree observations adopted into it via merged_into_project — so the value
  // matches the project-scoped counts instead of leaking the global earliest row.
  const stmt = project
    ? db.prepare(`
        SELECT created_at
        FROM observations
        WHERE (project = ? OR merged_into_project = ?)
        ORDER BY created_at_epoch ASC
        LIMIT 1
      `)
    : db.prepare(`
        SELECT created_at
        FROM observations
        ORDER BY created_at_epoch ASC
        LIMIT 1
      `);

  const row = (project ? stmt.get(project, project) : stmt.get()) as
    | { created_at: string }
    | undefined;
  return row ? row.created_at : null;
}
