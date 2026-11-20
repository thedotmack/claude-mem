import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { CONTENT_KIND_SPECS } from './CloudSync.js';
import { assertCanonicalDecimal, buildContentOperation, canonicalJson, compareCanonicalDecimals,
  incrementCanonicalDecimal, parseCanonicalOperation, stableDocumentId,
  type CanonicalWireOp, type ContentKind } from './CanonicalContent.js';

import { initializeConflictEvidenceSchema, isKnownConflictRevision, listConflictEvidence, readLocalConflictEvidence, SyncRecoveryError, type LocalConflictEvidence } from './SyncConflictEvidence.js';
import { initializeRepairReservations, reserveRepair, reservedRepair } from './SyncRepairReservation.js';
export { SyncRecoveryError } from './SyncConflictEvidence.js';
export interface ConflictRecoveryConfig {
  deviceId: string; userId: string; hubUrl: string; authToken: string;
  fetch?: typeof fetch; now?: () => number;
  readEvidence?: (kind: ContentKind, originLocalId: string) => Promise<LocalConflictEvidence>;
  listEvidence?: (limit: number) => Promise<unknown[]>;
}
interface Head { entity_rev: string; operation_sha256: string; seq: string }
interface HubEvidence {
  protocol_version: 1; capability: 'origin-repair-v1'; epoch: string;
  head_seq: string; projected_seq: string; entity_id: string; head: Head | null; op: CanonicalWireOp | null;
}
interface Prepared {
  scope: string;
  localEpoch: string | null;
  entityId: string; kind: ContentKind; originLocalId: string; localDigest: string;
  native: CanonicalWireOp; hub: HubEvidence; op: CanonicalWireOp; token: string; expiresAt: number;
}
export interface ConflictPreview {
  previewToken: string; expiresAt: number; entityId: string; kind: ContentKind; originLocalId: string;
  authority: 'local_origin'; choice: 'local_current'; proposedRevision: string;
  local: { revision: string; hash: string }; hub: { epoch: string; head: Head | null; deleted: boolean | null };
  conflicts: Array<{ revision: string; hash: string | null }>;
  conflictCount: number;
}

/** Called by worker startup, never by the read-only preview path. */
export function initializeConflictRecoverySchema(db: Database): void {
  initializeConflictEvidenceSchema(db);
  initializeRepairReservations(db);
  db.run(`CREATE TABLE IF NOT EXISTS sync_conflict_repairs (
    token TEXT PRIMARY KEY, entity_id TEXT NOT NULL, evidence TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_seq TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_sync_pull_quarantine_entity_id ON sync_pull_quarantine(entity_id,id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sync_dead_letter_content_entity ON sync_dead_letter(lane,queue_key,id)');
}

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('base64url');
const maxDecimal = (values: string[]) => values.reduce((a, b) => compareCanonicalDecimals(a, b) >= 0 ? a : b, '0');
const KINDS = new Set(['observation', 'summary', 'prompt', 'work_state']);

/** Explicit origin-only repair; this service never replays quarantine bodies. */
export class SyncConflictRecovery {
  private readonly previews = new Map<string, Prepared>();
  private readonly active = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly db: Database, private readonly config: ConflictRecoveryConfig) {
    this.fetchImpl = config.fetch ?? fetch; this.now = config.now ?? Date.now;
  }

  private scope(): string { return hash([this.config.userId, this.config.deviceId, this.config.hubUrl.replace(/\/$/, '')]); }

  list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SyncRecoveryError('invalid_limit', 400);
    return this.config.listEvidence?.(limit) ?? listConflictEvidence(this.db, limit);
  }

  private local(kind: ContentKind, originLocalId: string) {
    return readLocalConflictEvidence(this.db, this.config.deviceId, kind, originLocalId, { validateBodies: false });
  }

  private async readLocal(kind: ContentKind, originLocalId: string): Promise<LocalConflictEvidence> {
    return this.config.readEvidence ? this.config.readEvidence(kind, originLocalId)
      : readLocalConflictEvidence(this.db, this.config.deviceId, kind, originLocalId);
  }

  private async request(path: string, body: unknown): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.hubUrl.replace(/\/$/, '')}${path}`, {
        redirect: 'error',
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.authToken}`,
          'X-User-Id': this.config.userId, 'X-Device-Id': this.config.deviceId },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
    } catch { throw new SyncRecoveryError('repair_transport_unavailable', 503); }
    if (!response.ok) throw new SyncRecoveryError(response.status === 404 ? 'repair_capability_unavailable'
      : response.status === 401 || response.status === 403 ? 'repair_authority_denied' : 'repair_precondition_or_transport_failed', response.status);
    try { return await response.json(); } catch { throw new SyncRecoveryError('invalid_repair_response', 502); }
  }

  private async hub(entityId: string): Promise<HubEvidence> {
    const value = await this.request('/v1/sync/repair/head', { entity_id: entityId }) as HubEvidence;
    if (value.protocol_version !== 1 || value.capability !== 'origin-repair-v1' || value.entity_id !== entityId) throw new SyncRecoveryError('repair_capability_unavailable', 409);
    assertCanonicalDecimal(value.epoch, { positive: true }); assertCanonicalDecimal(value.head_seq); assertCanonicalDecimal(value.projected_seq);
    if (compareCanonicalDecimals(value.projected_seq, value.head_seq) > 0) throw new SyncRecoveryError('invalid_repair_response', 502);
    if ((value.head === null) !== (value.op === null)) throw new SyncRecoveryError('invalid_repair_response', 502);
    if (value.head && value.op) {
      const parsed = parseCanonicalOperation(value.op);
      assertCanonicalDecimal(value.head.seq, { positive: true });
      if (parsed.id !== entityId || parsed.origin_device_id !== this.config.deviceId || parsed.entity_rev !== value.head.entity_rev
        || value.op.operation_sha256 !== value.head.operation_sha256 || compareCanonicalDecimals(value.head.seq, value.head_seq) > 0) {
        throw new SyncRecoveryError('invalid_repair_response', 502);
      }
    }
    return value;
  }

  async preview(input: { kind: ContentKind; originLocalId: string; choice: 'local_current' }): Promise<ConflictPreview> {
    if (!input || !KINDS.has(input.kind) || input.choice !== 'local_current') throw new SyncRecoveryError('unsupported_repair_choice', 400);
    const originLocalId = assertCanonicalDecimal(input.originLocalId);
    const local = await this.readLocal(input.kind, originLocalId);
    if (local.unknownRevisionCount) throw new SyncRecoveryError('repair_evidence_revision_unknown');
    if (!local.native) throw new SyncRecoveryError('native_origin_required', 403);
    if (local.outbox.some(v => v.deleted)) throw new SyncRecoveryError('native_tombstone_requires_new_preview');
    const hub = await this.hub(local.entityId);
    if (local.localEpoch !== null && local.localEpoch !== hub.epoch) throw new SyncRecoveryError('local_epoch_changed');
    // A changed native row while the read was in flight invalidates the preview.
    const refreshed = await this.readLocal(input.kind, originLocalId);
    if (refreshed.unknownRevisionCount) throw new SyncRecoveryError('repair_evidence_revision_unknown');
    if (refreshed.digest !== local.digest) throw new SyncRecoveryError('local_evidence_changed');
    const reserved = reservedRepair(this.db, local.entityId);
    const revision = incrementCanonicalDecimal(maxDecimal([...local.revisions,
      ...(hub.head ? [hub.head.entity_rev] : []), ...(reserved ? [reserved.entity_rev] : [])]));
    const body = parseCanonicalOperation(local.native);
    const op = buildContentOperation({ kind: input.kind, originDeviceId: this.config.deviceId, originLocalId,
      entityRev: revision, payload: body.payload! });
    const token = randomUUID().replace(/-/g, '');
    const expiresAt = this.now() + 10 * 60_000;
    for (const [key, value] of this.previews) if (value.expiresAt <= this.now()) this.previews.delete(key);
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, { scope: this.scope(), entityId: local.entityId, kind: input.kind, originLocalId,
      localDigest: local.digest, localEpoch: local.localEpoch, native: local.native, hub, op, token, expiresAt });
    return { previewToken: token, expiresAt, entityId: local.entityId, kind: input.kind, originLocalId,
      authority: 'local_origin', choice: 'local_current', proposedRevision: revision,
      local: { revision: body.entity_rev, hash: local.native.operation_sha256 }, hub: { epoch: hub.epoch, head: hub.head,
        deleted: hub.op ? parseCanonicalOperation(hub.op).deleted : null },
      conflicts: local.quarantine.slice(0, 100).map(row => ({ revision: row.entity_rev!, hash: row.operation_sha256 ?? null })),
      conflictCount: local.quarantine.length };
  }

  /** Full local proof, including every retained conflicting head/revision. */
  private provesAccepted(evidence: LocalConflictEvidence, prepared: Prepared): boolean {
    if (evidence.unknownRevisionCount) return false;
    const body = parseCanonicalOperation(prepared.op);
    if (evidence.localEpoch !== prepared.localEpoch || evidence.native?.operation_sha256 !== prepared.op.operation_sha256) return false;
    if (evidence.heads.length !== 1 || evidence.heads[0].entity_rev !== body.entity_rev
      || evidence.heads[0].operation_sha256 !== prepared.op.operation_sha256 || evidence.heads[0].deleted) return false;
    for (const row of [...evidence.heads, ...evidence.outbox, ...evidence.quarantine, ...evidence.deadLetters]) {
      if (!isKnownConflictRevision(row.entity_rev)) return false;
      const order = compareCanonicalDecimals(row.entity_rev, body.entity_rev);
      if (order > 0 || (order === 0 && (row.operation_sha256 !== prepared.op.operation_sha256 || row.deleted))) return false;
    }
    const reservation = reservedRepair(this.db, body.id);
    return !reservation || compareCanonicalDecimals(reservation.entity_rev, body.entity_rev) <= 0;
  }

  async apply(input: { previewToken: string }) {
    if (!input || typeof input.previewToken !== 'string') throw new SyncRecoveryError('invalid_preview_token', 400);
    const token = input.previewToken;
    if (this.active.has(token)) throw new SyncRecoveryError('repair_in_progress');
    const saved = this.db.prepare('SELECT evidence, state, acknowledged_seq FROM sync_conflict_repairs WHERE token = ?').get(token) as any;
    const prepared: Prepared | undefined = saved ? JSON.parse(saved.evidence) : this.previews.get(token);
    if (!prepared || (!saved && prepared.expiresAt <= this.now())) throw new SyncRecoveryError('preview_expired');
    if (prepared.scope !== this.scope()) throw new SyncRecoveryError('repair_scope_changed', 403);
    this.active.add(token);
    try {
      const body = parseCanonicalOperation(prepared.op);
      const before = await this.readLocal(prepared.kind, prepared.originLocalId);
      if (before.unknownRevisionCount) {
        if (!saved?.acknowledged_seq) throw new SyncRecoveryError('repair_evidence_revision_unknown');
        this.db.prepare("UPDATE sync_conflict_repairs SET state='accepted_unresolved_evidence' WHERE token=?").run(token);
        return { state: 'accepted_unresolved_evidence', entityId: body.id, acknowledgedSeq: saved.acknowledged_seq };
      }
      if (before.localEpoch !== prepared.localEpoch) {
        if (!saved) throw new SyncRecoveryError('local_epoch_changed');
        this.db.prepare("UPDATE sync_conflict_repairs SET state='previous_epoch' WHERE token=?").run(token);
        return { state: 'previous_epoch', entityId: body.id, acknowledgedSeq: saved.acknowledged_seq ?? null };
      }
      if (!saved) {
        // Persist the chosen operation and its revision reservation in one
        // transaction before POST. Every native allocator sees the reservation
        // even if this process dies after the remote commit but before its ack.
        this.db.transaction(() => {
          const current = this.local(prepared.kind, prepared.originLocalId);
          if (current.unknownRevisionCount) throw new SyncRecoveryError('repair_evidence_revision_unknown');
          if (current.localEpoch !== prepared.localEpoch || current.digest !== prepared.localDigest) throw new SyncRecoveryError('local_evidence_changed');
          const reserved = reservedRepair(this.db, body.id);
          if (reserved && (compareCanonicalDecimals(reserved.entity_rev, body.entity_rev) > 0
            || (reserved.entity_rev === body.entity_rev && reserved.operation_sha256 !== prepared.op.operation_sha256))) throw new SyncRecoveryError('local_evidence_changed');
          reserveRepair(this.db, body.id, body.entity_rev, prepared.op.operation_sha256);
          this.db.prepare(`INSERT INTO sync_conflict_repairs (token,entity_id,evidence,state,created_at)
            VALUES (?,?,?,'prepared',?)`).run(token, body.id, JSON.stringify(prepared), this.now());
        }).immediate();
      }

      let acknowledgedSeq: string | null = saved?.acknowledged_seq ?? null;
      if (!acknowledgedSeq) {
        // A saved operation is an exact retry, including after a native edit or
        // deletion. Its reserved revision ensures their follow-up remains newer.
        const response = await this.request('/v1/sync/repair', { repair_id: token, expected_epoch: prepared.hub.epoch,
          expected_head: prepared.hub.head, op: prepared.op });
        const ack = response.acked?.[0];
        if (response.protocol_version !== 1 || response.capability !== 'origin-repair-v1' || response.epoch !== prepared.hub.epoch || response.acked?.length !== 1
          || ack.id !== body.id || ack.kind !== body.kind || ack.origin_local_id !== body.origin_local_id
          || ack.entity_rev !== body.entity_rev || ack.operation_sha256 !== prepared.op.operation_sha256) throw new SyncRecoveryError('invalid_repair_ack', 502);
        assertCanonicalDecimal(ack.seq, { positive: true }); assertCanonicalDecimal(response.head_seq); assertCanonicalDecimal(response.projected_seq);
        if (compareCanonicalDecimals(ack.seq, response.head_seq) > 0 || compareCanonicalDecimals(ack.seq, response.projected_seq) > 0) throw new SyncRecoveryError('repair_projection_pending', 503);
        acknowledgedSeq = ack.seq;
        const spec = CONTENT_KIND_SPECS.find(item => item.kind === prepared.kind)!;
        const currentEpoch = this.db.transaction(() => {
          const current = this.local(prepared.kind, prepared.originLocalId);
          if (current.unknownRevisionCount) {
            this.db.prepare("UPDATE sync_conflict_repairs SET state='accepted_unresolved_evidence',acknowledged_seq=? WHERE token=?").run(ack.seq, token);
            return 'accepted_unresolved_evidence';
          }
          // Receipt evidence is durable across epochs, but must never alter the
          // new epoch's heads, requeue or native synchronization state.
          if (current.localEpoch !== prepared.localEpoch) {
            this.db.prepare("UPDATE sync_conflict_repairs SET state='accepted_previous_epoch',acknowledged_seq=? WHERE token=?").run(ack.seq, token);
            return 'accepted_previous_epoch';
          }
          const unchanged = current.digest === prepared.localDigest || this.provesAccepted(current, prepared);
          const existing = current.heads[0];
          if (!existing || compareCanonicalDecimals(assertCanonicalDecimal(existing.entity_rev, { positive: true }), body.entity_rev) < 0) {
            this.db.prepare(`INSERT INTO sync_entity_heads (entity_id,kind,origin_device_id,origin_local_id,entity_rev,operation_sha256,deleted,updated_at_epoch)
              VALUES (?,?,?,?,?,?,0,?) ON CONFLICT(entity_id) DO UPDATE SET entity_rev=excluded.entity_rev,
              operation_sha256=excluded.operation_sha256,deleted=0,updated_at_epoch=excluded.updated_at_epoch`).run(
              body.id, body.kind, body.origin_device_id, body.origin_local_id, body.entity_rev, prepared.op.operation_sha256, this.now());
          }
          if (unchanged && current.native) {
            this.db.prepare(`UPDATE ${spec.localTable} SET sync_rev=?, synced_at=? WHERE id=? AND origin_device_id IS NULL`)
              .run(body.entity_rev, this.now(), prepared.originLocalId);
          } else if (current.native) {
            const currentRev = parseCanonicalOperation(current.native).entity_rev;
            const reservation = reservedRepair(this.db, body.id);
            const floor = maxDecimal([body.entity_rev, ...current.revisions, ...(reservation ? [reservation.entity_rev] : [])]);
            const next = compareCanonicalDecimals(currentRev, body.entity_rev) > 0 && currentRev === floor
              ? currentRev : incrementCanonicalDecimal(floor);
            this.db.prepare(`UPDATE ${spec.localTable} SET sync_rev=?, synced_at=NULL WHERE id=? AND origin_device_id IS NULL`)
              .run(next, prepared.originLocalId);
          } else {
            const reservation = reservedRepair(this.db, body.id);
            const floor = maxDecimal([body.entity_rev, ...current.revisions, ...(reservation ? [reservation.entity_rev] : [])]);
            if (!current.outbox.some(row => row.deleted && isKnownConflictRevision(row.entity_rev) && compareCanonicalDecimals(row.entity_rev, body.entity_rev) > 0)) {
              const next = incrementCanonicalDecimal(floor);
              const tombstone = buildContentOperation({ kind: prepared.kind, originDeviceId: this.config.deviceId,
                originLocalId: prepared.originLocalId, entityRev: next, payload: null, deleted: true, deletedAt: new Date(this.now()).toISOString() });
              this.db.prepare(`INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,deleted,created_at_epoch)
                VALUES(?,?,?,?,?,?,1,?)`).run(body.id, body.kind, body.origin_local_id, next, tombstone.body,tombstone.operation_sha256,this.now());
            }
          }
          this.db.prepare("UPDATE sync_conflict_repairs SET state='accepted',acknowledged_seq=? WHERE token=?").run(ack.seq, token);
          return 'current';
        }).immediate();
        if (currentEpoch !== 'current') return { state: currentEpoch, entityId: body.id, acknowledgedSeq };
      }

      const verified = await this.hub(body.id);
      const finalEvidence = await this.readLocal(prepared.kind, prepared.originLocalId);
      const remoteExact = verified.epoch === prepared.hub.epoch && verified.head?.entity_rev === body.entity_rev
        && verified.head?.operation_sha256 === prepared.op.operation_sha256 && compareCanonicalDecimals(verified.projected_seq, acknowledgedSeq!) >= 0;
      const state = this.db.transaction(() => {
        const latest = this.local(prepared.kind, prepared.originLocalId);
        const result = latest.localEpoch !== prepared.localEpoch ? 'accepted_previous_epoch'
          : latest.unknownRevisionCount ? 'accepted_unresolved_evidence'
          : remoteExact && latest.digest === finalEvidence.digest && this.provesAccepted(latest, prepared)
            ? 'verified' : 'accepted_local_or_hub_changed';
        this.db.prepare('UPDATE sync_conflict_repairs SET state=? WHERE token=?').run(result, token);
        return result;
      }).immediate();
      return { state, entityId: body.id, acknowledgedSeq };
    } finally { this.active.delete(token); }
  }
}
