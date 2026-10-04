import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/**
 * work_state_entries (v61): the agent's canonical to-do lists and working
 * state, written through the `work_state_write` MCP tool and shown at the start
 * of every session until closed.
 *
 * Append-only, one row per write. A list is replayed in id order and the latest
 * value of each key wins (WorkStateRenderer.foldWorkStateList), so a write only
 * names the keys it changes. Rows are keyed by the checkout's project, so lists
 * follow the project across sessions without living in the repo, where two
 * branches appending to the same file conflicted on merge.
 */

export type WorkStateValue = string | number | boolean | null;
export type WorkStateFields = Record<string, WorkStateValue>;

export interface WorkStateEntry {
  id: number;
  project: string;
  list_name: string;
  fields: WorkStateFields;
  created_at_epoch: number;
}

export function createWorkStateSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)');
}

export function appendWorkStateEntry(
  db: Database,
  entry: { project: string; listName: string; fields: WorkStateFields; createdAtEpoch?: number },
): number {
  const createdAtEpoch = entry.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.project, entry.listName, JSON.stringify(entry.fields), new Date(createdAtEpoch).toISOString(), createdAtEpoch);
  const id = Number(result.lastInsertRowid);
  logger.debug('DB', 'Work state entry appended', { id, project: entry.project, listName: entry.listName });
  return id;
}

/** Every entry stored under these project keys (and one list, when named), oldest first. */
export function getWorkStateEntries(db: Database, projects: string[], listName?: string): WorkStateEntry[] {
  if (projects.length === 0) return [];
  const placeholders = projects.map(() => '?').join(', ');
  const listFilter = listName === undefined ? '' : ' AND list_name = ?';
  const rows = db.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${placeholders})${listFilter}
    ORDER BY id
  `).all(...projects, ...(listName === undefined ? [] : [listName])) as Array<Omit<WorkStateEntry, 'fields'> & { fields: string }>;
  return rows.map(row => ({ ...row, fields: JSON.parse(row.fields) as WorkStateFields }));
}
