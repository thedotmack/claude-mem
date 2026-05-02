
import { Database } from 'bun:sqlite';
import type { RecentObservationRow } from './types.js';

export function getRecentObservations(
  db: Database,
  project: string,
  limit: number = 20
): RecentObservationRow[] {
  const stmt = db.prepare(`
    SELECT type, text, prompt_number, created_at
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);

  return stmt.all(project, limit) as RecentObservationRow[];
}

export function getFirstObservationCreatedAt(db: Database): string | null {
  const stmt = db.prepare(`
    SELECT created_at
    FROM observations
    ORDER BY created_at_epoch ASC
    LIMIT 1
  `);

  const row = stmt.get() as { created_at: string } | undefined;
  return row ? row.created_at : null;
}
