import type { Database } from 'bun:sqlite';

/**
 * cloud_outbox schema version. Shared by BOTH migration suites
 * (src/services/sqlite/migrations/runner.ts and src/services/sqlite/SessionStore.ts)
 * so the version row is identical regardless of which suite ran. Chosen to not
 * collide with any version used by either suite (runner uses up to 34 plus 33 for
 * server storage; SessionStore uses up to 32).
 */
export const CLOUD_OUTBOX_SCHEMA_VERSION = 35;

/**
 * Idempotently create the cloud_outbox table + index. Safe to run multiple times
 * and safe if BOTH migration suites run against the same DB: it uses
 * CREATE TABLE/INDEX IF NOT EXISTS and an INSERT OR IGNORE version row, and short-
 * circuits if the version row already exists. NO data, NO network — pure DDL.
 */
export function ensureCloudOutboxTable(db: Database): void {
  const applied = db
    .prepare('SELECT version FROM schema_versions WHERE version = ?')
    .get(CLOUD_OUTBOX_SCHEMA_VERSION) as { version: number } | undefined;
  if (applied) return;

  db.run(`
    CREATE TABLE IF NOT EXISTS cloud_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      local_id INTEGER,
      target_table TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      lane TEXT NOT NULL DEFAULT 'live',
      created_at_epoch INTEGER NOT NULL
    )
  `);

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_cloud_outbox_pending ON cloud_outbox(status, lane, id)`
  );

  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
    CLOUD_OUTBOX_SCHEMA_VERSION,
    new Date().toISOString()
  );
}
