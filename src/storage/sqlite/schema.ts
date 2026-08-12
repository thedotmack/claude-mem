// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';

export const SERVER_STORAGE_SCHEMA_VERSION = 33;

export const SERVER_OWNED_TABLES = [
  'api_keys',
  'audit_log'
] as const;

const initializedDatabases = new WeakSet<Database>();

export function ensureServerStorageSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;

  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      project_id TEXT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      last_used_at_epoch INTEGER,
      expires_at_epoch INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      project_id TEXT,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'api_key', 'system')),
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_team_time ON audit_log(team_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_project_time ON audit_log(project_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_type, actor_id)');

  initializedDatabases.add(db);
}
