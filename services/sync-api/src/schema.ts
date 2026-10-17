/**
 * Idempotent schema for the protocol-v2 sync store.
 * Applied at boot. Retention / rotation / compaction are out of scope.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_users (
  user_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  head_seq TEXT NOT NULL DEFAULT '0',
  projected_seq TEXT NOT NULL DEFAULT '0',
  projection_lease_token TEXT,
  projection_lease_expires_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_ops (
  user_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  origin_local_id TEXT,
  entity_rev TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  server_ts TEXT NOT NULL,
  PRIMARY KEY (user_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_ops_entity_rev
  ON sync_ops (user_id, entity_id, entity_rev);
CREATE INDEX IF NOT EXISTS sync_ops_user_seq_order
  ON sync_ops (user_id, length(seq), seq);

CREATE TABLE IF NOT EXISTS sync_entity_heads (
  user_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  origin_local_id TEXT,
  entity_rev TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  seq TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_id)
);

CREATE TABLE IF NOT EXISTS sync_devices (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT,
  last_ack_seq TEXT NOT NULL DEFAULT '0',
  last_seen BIGINT,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS sync_devices_user_seen
  ON sync_devices (user_id, last_seen DESC NULLS LAST, device_id);
`;

export async function applyMigrations(sql: import("postgres").Sql): Promise<void> {
	await sql`SET client_min_messages TO WARNING`;
	await sql.unsafe(SCHEMA_SQL);
	await sql`
		INSERT INTO schema_migrations (id) VALUES ('001_init')
		ON CONFLICT (id) DO NOTHING
	`;
}
