import type { Database } from 'bun:sqlite';
import { compareCanonicalDecimals } from './CanonicalContent.js';

/** A prepared repair may already be accepted remotely even if its reply is lost.
 * Native snapshot/delete allocators must never reuse its revision. */
export function initializeRepairReservations(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS sync_repair_reservations (
    entity_id TEXT PRIMARY KEY, entity_rev TEXT NOT NULL, operation_sha256 TEXT NOT NULL
  )`);
}
export function reservedRepair(db: Database, entityId: string): { entity_rev: string; operation_sha256: string } | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_repair_reservations'").get()) return null;
  return db.prepare('SELECT entity_rev,operation_sha256 FROM sync_repair_reservations WHERE entity_id=?').get(entityId) as
    { entity_rev: string; operation_sha256: string } | null;
}
export function reserveRepair(db: Database, entityId: string, revision: string, operationHash: string): void {
  const previous = reservedRepair(db, entityId);
  if (previous && compareCanonicalDecimals(previous.entity_rev, revision) > 0) return;
  db.prepare(`INSERT INTO sync_repair_reservations(entity_id,entity_rev,operation_sha256) VALUES(?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET entity_rev=excluded.entity_rev,operation_sha256=excluded.operation_sha256`)
    .run(entityId, revision, operationHash);
}
