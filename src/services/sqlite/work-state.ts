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
  /** Logical checkout key shared by its configured, legacy and parent read aliases. */
  scope_project?: string;
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
  ensureWorkStateSyncColumns(db);
}

/**
 * Cloud sync columns (v65), the shape the row tables got in v39/v41: a row
 * syncs as the `work_state` content kind (CloudSync KINDS, SyncApply
 * applyWorkState). `synced_at` stays NULL until the hub acks the row; the
 * origin columns stay NULL on native rows and name the writing device and its
 * rowid on rows pulled from another device, where the partial unique index
 * makes re-applying a pulled row an upsert; `sync_rev` is the entity revision.
 * The PRAGMA checks are the guard; the schema version row is bookkeeping.
 */
function ensureWorkStateSyncColumns(db: Database): void {
  const columns = new Set(
    (db.query('PRAGMA table_info(work_state_entries)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('synced_at')) db.run('ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER');
  if (!columns.has('origin_device_id')) db.run('ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT');
  if (!columns.has('origin_local_id')) db.run('ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT');
  if (!columns.has('sync_rev')) db.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'");
  db.run('CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL');
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `);
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

/**
 * Every entry stored under these project keys (and one list, when named), in
 * write order: the write clock first, so a row pulled from another device
 * replays where it was written rather than where it landed, then the rowid.
 */
export function getWorkStateEntries(db: Database, projects: string[], listName?: string): WorkStateEntry[] {
  if (projects.length === 0) return [];
  const placeholders = projects.map(() => '?').join(', ');
  const listFilter = listName === undefined ? '' : ' AND list_name = ?';
  const rows = db.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${placeholders})${listFilter}
    ORDER BY created_at_epoch, id
  `).all(...projects, ...(listName === undefined ? [] : [listName])) as Array<Omit<WorkStateEntry, 'fields'> & { fields: string }>;
  return rows.map(row => ({ ...row, fields: JSON.parse(row.fields) as WorkStateFields }));
}
