import type { Database } from 'bun:sqlite';

/** The memories Work View's hosted offer waits on: observations and summaries, never prompts or work state. */
const MEMORY_TABLES = [
  { kind: 'observation', table: 'observations' },
  { kind: 'summary', table: 'session_summaries' },
] as const;

/**
 * Whether the sync hub has ever acknowledged a memory written on this computer, read from the database, so it
 * survives worker restarts. A row counts when it is this computer's own (`origin_device_id IS NULL`), carries a real
 * acknowledgement stamp (`synced_at > 0`; -1 is quarantine) and is newer than the launch baseline: schema v47 stamped
 * `synced_at` on every pre-launch row without a hub acknowledgement and recorded each one, with the revision it
 * covers, in `sync_launch_exclusions` (SessionStore). A later edit of such a row has a higher revision and counts once
 * the hub acknowledges it. Replica rows from other devices are stamped on apply and never count.
 *
 * Without the exclusion ledger (a database the worker has not migrated), a stamp cannot be told from the baseline, so
 * nothing counts. Each table is one EXISTS that stops at its first match.
 */
export function ownMemorySynced(db: Database): boolean {
  const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_launch_exclusions'").get();
  if (!ledger) return false;
  for (const { kind, table } of MEMORY_TABLES) {
    const columns = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>)
      .map(column => column.name));
    if (!columns.has('synced_at') || !columns.has('origin_device_id') || !columns.has('sync_rev')) continue;
    const row = db.prepare(`SELECT EXISTS (
      SELECT 1 FROM ${table} t
      WHERE t.origin_device_id IS NULL AND t.synced_at > 0
        AND NOT EXISTS (
          SELECT 1 FROM sync_launch_exclusions e
          WHERE e.kind = ? AND e.origin_local_id = CAST(t.id AS TEXT)
            AND (length(CAST(t.sync_rev AS TEXT)) < length(e.through_rev)
              OR (length(CAST(t.sync_rev AS TEXT)) = length(e.through_rev) AND CAST(t.sync_rev AS TEXT) <= e.through_rev))
        )
      LIMIT 1
    ) AS synced`).get(kind) as { synced: number };
    if (row.synced === 1) return true;
  }
  return false;
}
