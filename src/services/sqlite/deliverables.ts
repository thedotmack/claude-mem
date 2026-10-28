import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/**
 * deliverables: one row per file the Stop hook copied into the project's
 * deliverables bucket (src/shared/deliverables.ts), for one session. The row
 * is what My Work links: GET /api/deliverables/:id/:filename serves the
 * bucket copy named here, never a path a client supplies.
 *
 * A row is keyed by (platform, session, bucket copy), so a re-fired Stop or a
 * second turn that touched the same file again inserts nothing; the same file
 * attached by another session gets its own row, linked to that session's
 * request. Rows are local only: the copies they name live on this machine.
 */
export interface DeliverableRow {
  id: number;
  project: string;
  content_session_id: string;
  platform_source: string;
  agent_id: string | null;
  title: string;
  kind: string;
  source_path: string;
  bucket_path: string;
  bytes: number;
  sha256: string;
  /** 1 when an agent attached it through a work-state field, 0 when the hook inferred it from a write. */
  declared: number;
  list_name: string | null;
  field: string | null;
  tool_use_id: string | null;
  occurred_at_epoch: number;
  created_at: string;
  created_at_epoch: number;
}

export interface RecordDeliverableInput {
  project: string;
  contentSessionId: string;
  platformSource: string;
  agentId?: string | null;
  title: string;
  kind: string;
  sourcePath: string;
  bucketPath: string;
  bytes: number;
  sha256: string;
  declared: boolean;
  listName?: string | null;
  field?: string | null;
  toolUseId?: string | null;
  occurredAtEpoch: number;
  createdAtEpoch?: number;
}

export function createDeliverablesSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      platform_source TEXT NOT NULL,
      agent_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      bucket_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      declared INTEGER NOT NULL DEFAULT 0,
      list_name TEXT,
      field TEXT,
      tool_use_id TEXT,
      occurred_at_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)');
  db.run('CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)');
}

/** Inserts the row, or finds the one already recorded for this session and bucket copy. */
export function recordDeliverable(db: Database, input: RecordDeliverableInput): { id: number; inserted: boolean } {
  const createdAtEpoch = input.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.project, input.contentSessionId, input.platformSource, input.agentId ?? null, input.title, input.kind,
    input.sourcePath, input.bucketPath, input.bytes, input.sha256, input.declared ? 1 : 0, input.listName ?? null,
    input.field ?? null, input.toolUseId ?? null, input.occurredAtEpoch, new Date(createdAtEpoch).toISOString(), createdAtEpoch,
  );
  if (result.changes > 0) {
    const id = Number(result.lastInsertRowid);
    logger.debug('DB', 'Deliverable recorded', { id, project: input.project, bucketPath: input.bucketPath });
    return { id, inserted: true };
  }
  const existing = db.prepare('SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?')
    .get(input.platformSource, input.contentSessionId, input.bucketPath) as { id: number } | undefined;
  return { id: existing?.id ?? 0, inserted: false };
}

export function getDeliverable(db: Database, id: number): DeliverableRow | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return (db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as DeliverableRow | undefined) ?? null;
}

/** Newest first, since `sinceEpoch`. The caller states its limit. */
export function getDeliverablesSince(db: Database, sinceEpoch: number, limit: number): DeliverableRow[] {
  return db.prepare('SELECT * FROM deliverables WHERE created_at_epoch >= ? ORDER BY id DESC LIMIT ?').all(sinceEpoch, limit) as DeliverableRow[];
}
