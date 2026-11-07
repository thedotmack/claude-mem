import { Database } from 'bun:sqlite';

/** Invoked only in the dedicated inventory worker, never on the HTTP event loop. */
export function readHistoricalSyncScope(databasePath: string): number | null {
  const db = new Database(databasePath, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    let count = 0;
    for (const [kind, table] of Object.entries({ observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', work_state: 'work_state_entries' })) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM sync_launch_exclusions e
        JOIN ${table} t ON t.id = CAST(e.origin_local_id AS INTEGER)
        WHERE e.kind = ? AND t.origin_device_id IS NULL AND
        (length(CAST(t.sync_rev AS TEXT)) < length(e.through_rev) OR
         (length(CAST(t.sync_rev AS TEXT)) = length(e.through_rev) AND CAST(t.sync_rev AS TEXT) <= e.through_rev))`).get(kind) as { count: number };
      count += row.count;
    }
    return count;
  } finally { db.close(); }
}
