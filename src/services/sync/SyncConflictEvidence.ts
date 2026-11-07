import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { CONTENT_KIND_SPECS } from './CloudSync.js';
import { assertCanonicalDecimal, buildContentOperation, canonicalJson, parseCanonicalOperation, stableDocumentId, type CanonicalWireOp, type ContentKind } from './CanonicalContent.js';

export class SyncRecoveryError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

/** Above this limit, narrow/investigate the retained history before automated repair. */
export const MAX_CONFLICT_EVIDENCE_ROWS = 1024;
export const MAX_CONFLICT_EVIDENCE_BYTES = 4_000_000;
type RevisionEvidence = { entity_rev: string | null; operation_sha256?: string | null; deleted?: number; id?: number; epoch?: string; seq?: string };
export function isKnownConflictRevision(value: unknown): value is string {
  try { assertCanonicalDecimal(value, { positive: true }); return true; } catch { return false; }
}
export interface LocalConflictEvidence {
  native: CanonicalWireOp | null;
  entityId: string;
  revisions: string[];
  quarantine: RevisionEvidence[];
  heads: RevisionEvidence[];
  outbox: RevisionEvidence[];
  deadLetters: RevisionEvidence[];
  digest: string;
  localEpoch: string | null;
  unknownRevisionCount: number;
}

/** Tracks even invalid body-only edits without rehashing body history on the HTTP writer. */
export function initializeConflictEvidenceSchema(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS sync_conflict_body_versions(entity_id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  for (const [event, identities] of [
    ['INSERT', ['NEW.entity_id']], ['DELETE', ['OLD.entity_id']], ['UPDATE', ['OLD.entity_id', 'NEW.entity_id']],
  ] as const) {
    const statements = identities.map(identity => `INSERT INTO sync_conflict_body_versions(entity_id,version)
      VALUES(${identity},1) ON CONFLICT(entity_id) DO UPDATE SET version=version+1;`).join('\n');
    db.run(`CREATE TRIGGER IF NOT EXISTS sync_conflict_body_${event.toLowerCase()} AFTER ${event} ON sync_content_outbox BEGIN ${statements} END`);
  }
}

export function listConflictEvidence(db: Database, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SyncRecoveryError('invalid_limit', 400);
  return db.prepare(`SELECT entity_id, kind, origin_device_id, origin_local_id,
    COUNT(*) AS operations, MAX(created_at_epoch) AS latest_at FROM sync_pull_quarantine
    WHERE entity_id IS NOT NULL GROUP BY entity_id ORDER BY latest_at DESC LIMIT ?`).all(limit);
}

/** Read metadata hashes, never retained canonical outbox/quarantine bodies. Runs off-thread for HTTP. */
export function readLocalConflictEvidence(db: Database, deviceId: string, kind: ContentKind, originLocalId: string, options: { validateBodies: boolean } = { validateBodies: true }): LocalConflictEvidence {
  return db.transaction(() => {
    const spec = CONTENT_KIND_SPECS.find(item => item.kind === kind);
    if (!spec) throw new SyncRecoveryError('unsupported_repair_choice', 400);
    assertCanonicalDecimal(originLocalId);
    const row = db.prepare(spec.selectOneSql).get(originLocalId) as Record<string, unknown> | null;
    if (row && row.origin_device_id != null) throw new SyncRecoveryError('native_origin_required', 403);
    if (row && kind === 'work_state' && /^__my_work_v[0-9].*:/.test(String(row.list_name ?? ''))) {
      throw new SyncRecoveryError('shared_work_repair_unsupported');
    }
    const entityId = stableDocumentId(kind, deviceId, originLocalId);
    const heads = db.prepare('SELECT entity_rev, operation_sha256, deleted FROM sync_entity_heads WHERE entity_id = ?').all(entityId) as RevisionEvidence[];
    const outbox = db.prepare(`SELECT id, entity_rev, operation_sha256, deleted FROM sync_content_outbox
      WHERE entity_id = ? ORDER BY id LIMIT ?`).all(entityId, MAX_CONFLICT_EVIDENCE_ROWS + 1) as RevisionEvidence[];
    const quarantine = db.prepare(`SELECT id, epoch, seq, entity_rev, operation_sha256 FROM sync_pull_quarantine
      WHERE entity_id = ? ORDER BY id LIMIT ?`).all(entityId, MAX_CONFLICT_EVIDENCE_ROWS + 1) as RevisionEvidence[];
    const deadLetters = db.prepare(`SELECT id, entity_rev FROM sync_dead_letter
      WHERE lane='content' AND queue_key=? ORDER BY id LIMIT ?`).all(entityId, MAX_CONFLICT_EVIDENCE_ROWS + 1) as RevisionEvidence[];
    if (heads.length + outbox.length + quarantine.length + deadLetters.length > MAX_CONFLICT_EVIDENCE_ROWS) {
      throw new SyncRecoveryError('repair_evidence_too_large', 409);
    }
    const bodyVersion = (db.prepare('SELECT CAST(version AS TEXT) AS version FROM sync_conflict_body_versions WHERE entity_id=?').get(entityId) as { version: string } | null)?.version ?? '0';
    if (options.validateBodies) {
      const bytes = (db.prepare('SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM sync_content_outbox WHERE entity_id=?').get(entityId) as { bytes: number }).bytes;
      if (bytes > MAX_CONFLICT_EVIDENCE_BYTES) throw new SyncRecoveryError('repair_evidence_too_large',409);
      const wrappers = db.prepare('SELECT entity_rev,body,operation_sha256 FROM sync_content_outbox WHERE entity_id=? ORDER BY id LIMIT ?')
        .all(entityId,MAX_CONFLICT_EVIDENCE_ROWS + 1) as Array<CanonicalWireOp & { entity_rev: string }>;
      for (const wrapper of wrappers) {
        try {
          const parsed = parseCanonicalOperation({body:wrapper.body,operation_sha256:wrapper.operation_sha256});
          if (parsed.id !== entityId || parsed.entity_rev !== wrapper.entity_rev) throw new Error('identity mismatch');
        } catch { throw new SyncRecoveryError('repair_evidence_corrupt',409); }
      }
    }
    const localEpoch = (db.prepare("SELECT v FROM sync_state WHERE k='epoch'").get() as { v: string } | null)?.v ?? null;
    const rev = row ? assertCanonicalDecimal(row.sync_rev, { positive: true }) : null;
    const native = row ? buildContentOperation({ kind, originDeviceId: deviceId, originLocalId, entityRev: rev!, payload: spec.toBody(row as never) }) : null;
    // Retained malformed wrappers can legitimately have no revision. Keep their
    // diagnostics, but do not infer an ordering or a safe correction above them.
    const retained = [...heads, ...outbox, ...quarantine, ...deadLetters];
    const unknownRevisionCount = retained.filter(item => !isKnownConflictRevision(item.entity_rev)).length;
    const revisions = [...(rev ? [rev] : []), ...retained.map(item => item.entity_rev).filter(isKnownConflictRevision)];
    const digest = createHash('sha256').update(canonicalJson({ native, heads, outbox, quarantine, deadLetters, localEpoch, bodyVersion })).digest('base64url');
    return { native, entityId, revisions, quarantine, heads, outbox, deadLetters, digest, localEpoch, unknownRevisionCount };
  })();
}
