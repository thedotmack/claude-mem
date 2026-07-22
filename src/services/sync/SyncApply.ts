// SyncApply — the client-side apply path for the two-lane sync hub
// (plan Phase 2, tasks 2-3). Pulled ops from the per-user SyncHub log
// (workers/sync-hub/src/do/SyncHub.ts) are applied to the local SQLite in ONE
// transaction per batch, with the pull cursor advanced in that SAME
// transaction — crash-safe exactly-once: either a batch's rows AND its cursor
// land together, or neither does. Application is idempotent (re-applying any
// prefix of the log converges to the same state), so an epoch reset can
// simply re-pull from seq 0.
//
// ECHO GUARD (structural, not heuristic): every row this module writes is
// pre-stamped `synced_at = now`. The push drain (CloudSync.drainKind) selects
// `WHERE synced_at IS NULL`, so an applied remote row can never be selected
// for re-push. Ops whose `origin_device` equals this device's own id are
// skipped outright (echo of our own pushes).
//
// DEVICE IDENTITY: this module never resolves an identity of its own. The
// caller MUST pass the id resolved by CloudSync.resolveDeviceId
// (CloudSync.ts:529-594 — settings key CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID,
// legacy-state adoption, fail-closed). A second identity source would fork
// origin attribution; do not add one.
//
// ---------------------------------------------------------------------------
// BODY FIELD MAPPING (canonical — Phase 3's push MUST construct op bodies
// exactly like this; field names are the local column names, values exactly
// as stored — JSON-string columns stay JSON strings, no re-parsing):
//
// kind 'observation'  (op.origin_id = String(observations.id) on the origin):
//   { memory_session_id, project, text, type, title, subtitle, facts,
//     narrative, concepts, files_read, files_modified, prompt_number,
//     discovery_tokens, content_hash, generated_by_model, agent_type,
//     agent_id, metadata, merged_into_project, created_at, created_at_epoch }
//
// kind 'summary'  (op.origin_id = String(session_summaries.id)):
//   { memory_session_id, project, request, investigated, learned, completed,
//     next_steps, files_read, files_edited, notes, prompt_number,
//     discovery_tokens, merged_into_project, created_at, created_at_epoch }
//
// kind 'prompt'  (op.origin_id = String(user_prompts.id)):
//   { content_session_id, prompt_number, prompt_text, created_at,
//     created_at_epoch, memory_session_id, project, platform_source }
//   The last three are resolved on the ORIGIN via the same LEFT JOIN the
//   prompt drain already uses (user_prompts up LEFT JOIN sdk_sessions s ON
//   up.session_db_id = s.id → s.memory_session_id, s.project,
//   s.platform_source); they are nullable. `session_db_id` NEVER travels —
//   it is a device-local rowid and is re-resolved locally on apply.
//
// Excluded from every row body: id (rides as op.origin_id), synced_at
// (device-local push state), origin_device_id/origin_local_id/sync_rev (ride
// as op.origin_device/op.origin_id/op.rev), relevance_count (device-local
// usage counter).
//
// kind 'mutation'  (op.origin_id = op UUID minted at the mutation site):
//   set_title:
//     { op: 'set_title',
//       target: { memory_session_id?, content_session_id?, platform_source? },
//       fields: { custom_title } }
//   set_prompt_session (the requeuePromptSync repair as an ordered op):
//     { op: 'set_prompt_session',
//       target: { origin_device_id, origin_local_id },
//       fields: { memory_session_id, project?, content_session_id?,
//                 platform_source? } }
//   remap_project (both remap sites — WorktreeAdoption.ts:210-215 emits
//     where:{project, merged_into_project_is_null:true} +
//     fields:{merged_into_project}; ProcessManager.ts:312-314 emits
//     where:{memory_session_id} + fields:{project}):
//     { op: 'remap_project',
//       where: { project?, memory_session_id?, merged_into_project_is_null? },
//       fields: { project?, merged_into_project? } }
// ---------------------------------------------------------------------------
//
// REV SEMANTICS (apply side):
//   - Row ops: applied only when op.rev > the local row's sync_rev. Equal rev
//     is skipped — the hub's ops_entity unique index is first-write-wins, so
//     one (device, kind, origin_id, rev) has exactly one body and re-applying
//     it would rewrite identical values (skipping also avoids FTS trigger
//     churn on re-pulls).
//   - Mutation ops: applied when op.rev >= the target row's sync_rev (plan
//     Phase 2 task 2); stale mutations are silently skipped. Matched rows get
//     sync_rev = op.rev. set_title does not consult rev at all — see the
//     parking section below.
//
// REV MINTING RULES (emit side — Phase 3 MUST implement these verbatim; the
// apply guards above are written against them, and an emitter that sends
// rev:1 where a bump is required produces silently-skipped ops):
//   - mutation origin_id: a per-op UUID (crypto.randomUUID()) minted ONCE
//     when the mutation is enqueued, stored with the queued op, and REUSED on
//     every retry of that same push (the hub dedupes on
//     (origin_device, kind, origin_id, rev)). A UUID is never reused for a
//     different logical mutation — unique forever.
//   - set_prompt_session: at the mutation site, bump the target user_prompts
//     row's sync_rev by 1 (UPDATE ... SET sync_rev = sync_rev + 1) and emit
//     rev = that post-bump sync_rev. Replicas apply when
//     op.rev >= their row's sync_rev.
//   - remap_project: compute R = 1 + COALESCE(MAX(sync_rev) over the rows the
//     where-predicate matches on the emitting device, 0); stamp
//     sync_rev = R on those matched rows in the same transaction, and emit
//     rev = R. This guarantees op.rev >= every matched row's sync_rev on the
//     emitting device (the stated invariant; replicas that carry
//     higher-revved rows for the same predicate skip those rows per the
//     guard).
//   - set_title: emit rev = 1 always; rev is not consulted when applying —
//     titles converge by hub-log order plus parking (below).
//
// SET_TITLE CONVERGENCE (title parking): custom_title's only writer runs at
// session creation (createSDKSession, SessionStore.ts:1922-1937), so the hub
// log always carries set_title BEFORE the row ops that would create the
// session locally, and the op targets {content_session_id, platform_source}
// (no memory_session_id is registered at emit time). applySetTitle therefore
// resolves in three steps: (1) direct sdk_sessions match (by
// memory_session_id or (platform_source, content_session_id)); (2) via a
// replicated prompt's content_session_id → session_db_id (covers
// row-ops-first arrival, where an observation-created stub carries a
// synthetic content id); (3) otherwise the title is PARKED in sync_state
// (key 'parked_title:mem:<memory_session_id>' or
// 'parked_title:content:<platform>:<content_session_id>') and claimed the
// moment a session is created for — or an op carrying the content↔memory
// association passes through ensureSessionForMemoryId for — that identity.
// Claims are NULL-guarded (only fill an unset custom_title — the
// createSDKSession precedent); direct applications overwrite (log order
// wins). Parking lives in sync_state, so it commits in the same transaction
// as the op that parked it, and a parked title whose session never
// materializes is inert residue. A parked set_title counts as 'applied'.
//
// SESSION STUBS: observations/session_summaries FK memory_session_id →
// sdk_sessions(memory_session_id) and foreign keys are ON
// (connection.ts:45), but sdk_sessions rows themselves do not sync. Applying
// a remote row whose session is unknown locally therefore creates a minimal
// stub session (precedent: SessionStore.getOrCreateManualSession). Stubs use
// the body's content_session_id/platform_source when the body carries them
// (prompts do); otherwise content_session_id falls back to the
// memory_session_id (globally unique, so no collision).
//
// FTS: all writes here are plain SQL INSERT/UPDATE against the base tables,
// so the existing FTS5 triggers (observations/summaries:
// SessionSearch.ts:76-152; user_prompts: SessionStore.ts:867-895) index them
// automatically. There is no FTS-external write path in this module.
//
// CHROMA: newly inserted rows are forwarded to Chroma AFTER commit,
// fire-and-forget (.then().catch() — the ResponseProcessor.ts pattern).
// The ChromaSyncLike instance is injected; Phase 3's SyncClient wires
// DatabaseManager.getChromaSync() here. Omitting it skips Chroma (the boot
// backfill pass reconciles later).
//
// KNOWN LIMITATIONS (accepted for Phase 2 — documented, not bugs to trip on):
//   - Content-hash collision path: an incoming observation whose
//     (memory_session_id, content_hash) already exists under a DIFFERENT
//     identity is skipped and its origin identity is never recorded locally,
//     so later revs of that origin row also skip (no row matches the origin
//     pair). Convergence for such rows relies on the mutation lane
//     (remap/repair predicates), not the row lane.
//   - Stub-session warts: a stub created from observations/summaries only
//     keeps content_session_id = memory_session_id (their bodies carry no
//     content id) until an op carrying the real association (prompt row op
//     or set_prompt_session) arrives — and even then the stub's content id
//     is not rewritten; only prompt linking and parked-title claiming use
//     the association. Stubs are created with status 'completed' and stay
//     'completed' even if a live local session later adopts them.

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';
import {
  assertCanonicalDecimal,
  compareCanonicalDecimals,
  incrementCanonicalDecimal,
} from './CanonicalContent.js';

/** One op as returned by the hub's getChanges (SyncHub.ts ChangeOp). */
export interface SyncOp {
  seq: string;
  kind: 'observation' | 'summary' | 'prompt' | 'mutation';
  origin_device: string;
  origin_id: string;
  rev: string;
  body: string;
  server_ts: number;
  /** Canonical-v2 identity/head metadata (present on Hub wire decoding). */
  entity_id?: string;
  entity_rev?: string;
  operation_sha256?: string;
  deleted?: boolean;
  deleted_at?: string | null;
}

/**
 * Structural subset of ChromaSync (ChromaSync.ts:375-530) so tests can stub
 * it and Phase 3 can pass the real instance.
 */
export interface ChromaSyncLike {
  syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: {
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void>;
  syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: {
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      notes: string | null;
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void>;
  syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void>;
}

export interface SyncApplyOptions {
  /**
   * This device's sync identity — MUST be the id CloudSync resolved
   * (status().deviceId); never mint a separate one here.
   */
  deviceId: string;
  /** Optional Chroma forwarder; fired after commit, never awaited. */
  chromaSync?: ChromaSyncLike | null;
  /** Injectable clock for the synced_at stamp (tests). NEVER row identity. */
  now?: () => number;
}

export interface ApplyOpsOptions {
  /**
   * The epoch the pull response carried. If it differs from the stored
   * epoch, the cursor is reset to 0, the new epoch is stored, and NOTHING
   * from this batch is applied (the batch was fetched with the stale
   * cursor); the caller re-pulls from 0 — apply is idempotent by design, so
   * the re-pull converges.
   */
  epoch?: string;
  /** HTTP pages must begin at cursor+1 and contain no gaps. */
  requireContiguous?: boolean;
}

export interface ApplyResult {
  /** Ops that inserted or updated at least one row. */
  applied: number;
  /** Ops skipped because origin_device is this device (echo of our push). */
  skippedOwn: number;
  /** Ops skipped by the rev guard (or content-dupe DO NOTHING). */
  skippedStale: number;
  /** Ops skipped because seq <= stored cursor (already applied earlier). */
  skippedCursor: number;
  /** Cursor after this call. */
  cursor: string;
  /** True when the epoch guard reset the cursor; batch was NOT applied. */
  epochReset: boolean;
}

interface RowIdRev {
  id: number;
  sync_rev: string;
}

type ChromaJob = () => Promise<void>;

function invalidOp(op: SyncOp, message: string): Error {
  return new Error(`SyncApply: invalid op seq=${op.seq} kind=${op.kind} origin=${op.origin_device}/${op.origin_id}: ${message}`);
}

/**
 * Typed field readers — loud, not lossy: a MISSING (or null) field is
 * tolerated as null (required-ness is enforced by the per-kind checks), but
 * a field that is PRESENT with the wrong type is a malformed body and throws,
 * failing the batch instead of silently writing NULL.
 */
function fieldString(op: SyncOp, obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  throw invalidOp(op, `field ${key} must be a string, got ${typeof v}`);
}

function fieldNumber(op: SyncOp, obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw invalidOp(op, `field ${key} must be a finite number, got ${typeof v}`);
}

/** Parse a JSON-string list column for Chroma; never throws. */
function parseListColumn(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class SyncApply {
  private readonly db: Database;
  private readonly deviceId: string;
  private readonly chromaSync: ChromaSyncLike | null;
  private readonly now: () => number;

  constructor(db: Database, options: SyncApplyOptions) {
    if (!options.deviceId) {
      // Same fail-closed posture as CloudSync device resolution: applying
      // without an identity would mis-classify our own echoes as remote rows.
      throw new Error('SyncApply requires a non-empty deviceId (use the CloudSync-resolved id)');
    }
    this.db = db;
    this.deviceId = options.deviceId;
    this.chromaSync = options.chromaSync ?? null;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // sync_state (cursor + epoch)
  // -------------------------------------------------------------------------

  getCursor(): string {
    const row = this.db.prepare(`SELECT v FROM sync_state WHERE k = 'cursor'`).get() as { v: string } | undefined;
    return assertCanonicalDecimal(row?.v ?? '0');
  }

  getEpoch(): string | null {
    const row = this.db.prepare(`SELECT v FROM sync_state WHERE k = 'epoch'`).get() as { v: string } | undefined;
    return row?.v ?? null;
  }

  private setState(k: 'cursor' | 'epoch', v: string): void {
    this.db.prepare(`
      INSERT INTO sync_state (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v
    `).run(k, v);
  }

  /**
   * Epoch guard (plan Phase 2 task 3). Returns true when the epoch changed
   * and the cursor was reset to 0 — the caller must discard the current page
   * and re-pull from 0. First-ever epoch is adopted without a reset.
   *
   * An epoch MISMATCH means the hub's log was lost/rebuilt: eligible native
   * revisions this device previously pushed are re-nulled so the push drain
   * can repopulate the rebuilt log. The one-time v47 launch baseline is
   * deliberately excluded through the exact revisions recorded in
   * sync_launch_exclusions; a later edit has a higher revision and is
   * eligible. Replica rows and quarantined (-1) rows are never requeued.
   */
  handleEpoch(epoch: string): boolean {
    const stored = this.getEpoch();
    if (stored === epoch) return false;
    let requeued = 0;
    const tx = this.db.transaction(() => {
      this.setState('epoch', epoch);
      if (stored !== null) {
        this.setState('cursor', '0');
        for (const { table, kind } of [
          { table: 'observations', kind: 'observation' },
          { table: 'session_summaries', kind: 'summary' },
          { table: 'user_prompts', kind: 'prompt' },
        ]) {
          requeued += this.db.prepare(`
            UPDATE ${table} SET synced_at = NULL
            WHERE synced_at > 0
              AND origin_device_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM sync_launch_exclusions AS launch
                WHERE launch.kind = ?
                  AND launch.origin_local_id = CAST(${table}.id AS TEXT)
                  AND (
                    LENGTH(launch.through_rev) > LENGTH(CAST(${table}.sync_rev AS TEXT))
                    OR (
                      LENGTH(launch.through_rev) = LENGTH(CAST(${table}.sync_rev AS TEXT))
                      AND launch.through_rev >= CAST(${table}.sync_rev AS TEXT)
                    )
                  )
              )
          `).run(kind).changes;
        }
      }
    });
    tx();
    if (stored !== null) {
      logger.warn('SYNC_APPLY', 'Sync hub epoch changed — cursor reset, full re-pull required, eligible native revisions requeued', {
        oldEpoch: stored,
        newEpoch: epoch,
        requeued,
      });
      return true;
    }
    logger.info('SYNC_APPLY', 'Adopted initial sync hub epoch', { epoch });
    return false;
  }

  // -------------------------------------------------------------------------
  // applyOps
  // -------------------------------------------------------------------------

  /**
   * Apply one pulled batch. Ops must be in ascending seq order (the hub
   * returns them that way). Runs in ONE transaction: row upserts, mutation
   * UPDATEs, and the cursor advance commit together or roll back together.
   * A malformed op throws and rolls back the whole batch — the cursor does
   * not move, so the next pull retries the same page (loud, not lossy).
   */
  applyOps(ops: SyncOp[], options: ApplyOpsOptions = {}): ApplyResult {
    if (options.epoch !== undefined && this.handleEpoch(options.epoch)) {
      return {
        applied: 0,
        skippedOwn: 0,
        skippedStale: 0,
        skippedCursor: 0,
        cursor: '0',
        epochReset: true,
      };
    }

    const result: ApplyResult = {
      applied: 0,
      skippedOwn: 0,
      skippedStale: 0,
      skippedCursor: 0,
      cursor: this.getCursor(),
      epochReset: false,
    };
    if (ops.length === 0) return result;

    const chromaJobs: ChromaJob[] = [];

    const tx = this.db.transaction(() => {
      const cursor = this.getCursor();
      let lastSeq = cursor;

      for (const op of ops) {
        const seq = assertCanonicalDecimal(op.seq, { positive: true });
        assertCanonicalDecimal(op.rev, { positive: true });
        // Strict HTTP pages describe the exact raw suffix after our cursor.
        // Validate every supplied sequence before the ordinary replay skip;
        // otherwise a stale prefix (even an out-of-order one) is silently
        // discarded and a malformed page can look contiguous.
        if (options.requireContiguous === true && seq !== incrementCanonicalDecimal(lastSeq)) {
          throw new Error(`SyncApply: sequence gap (expected ${incrementCanonicalDecimal(lastSeq)}, got ${seq})`);
        }
        if (compareCanonicalDecimals(seq, cursor) <= 0) {
          result.skippedCursor++;
          continue;
        }
        if (compareCanonicalDecimals(seq, lastSeq) <= 0) {
          throw new Error(`SyncApply: ops out of order (seq ${op.seq} after ${lastSeq})`);
        }
        lastSeq = seq;

        if (op.origin_device === this.deviceId) {
          result.skippedOwn++;
          continue;
        }

        let outcome: 'applied' | 'stale';
        if (op.kind === 'mutation') {
          outcome = this.applyMutation(op);
        } else {
          outcome = this.applyCanonicalRowOp(op, chromaJobs);
        }
        if (outcome === 'applied') result.applied++;
        else result.skippedStale++;
      }

      // Cursor advance IN THE SAME TRANSACTION as the rows (crash-safe
      // exactly-once): a crash before COMMIT leaves both unmoved.
      if (compareCanonicalDecimals(lastSeq, cursor) > 0) {
        this.setState('cursor', lastSeq);
      }
      result.cursor = lastSeq;
    });
    tx();

    // Chroma AFTER commit, fire-and-forget (ResponseProcessor.ts pattern):
    // a Chroma failure must never fail or re-order durable application.
    for (const job of chromaJobs) {
      job().then(() => {
        logger.debug('SYNC_APPLY', 'Applied row forwarded to Chroma');
      }).catch((error) => {
        logger.error('SYNC_APPLY', 'Chroma forward of applied row failed, continuing without vector search', {},
          error instanceof Error ? error : new Error(String(error)));
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Row ops
  // -------------------------------------------------------------------------

  private parseBody(op: SyncOp): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(op.body);
    } catch {
      throw invalidOp(op, 'body is not parseable JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw invalidOp(op, 'body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  private findByOrigin(table: string, originDevice: string, originId: string): RowIdRev | undefined {
    return this.db.prepare(
      `SELECT id, CAST(sync_rev AS TEXT) AS sync_rev
       FROM ${table} WHERE origin_device_id = ? AND origin_local_id = ?`
    ).get(originDevice, originId) as RowIdRev | undefined;
  }

  /**
   * Canonical-v2 head ledger. It survives local row deletion and epoch replay,
   * so a stale live op cannot resurrect a tombstoned entity.
   */
  private applyCanonicalRowOp(op: SyncOp, chromaJobs: ChromaJob[]): 'applied' | 'stale' {
    if (!op.entity_id || !op.entity_rev || !op.operation_sha256) {
      return this.applyRowOp(op, chromaJobs); // internal legacy fixtures only
    }
    const head = this.db.prepare(`
      SELECT entity_rev, operation_sha256
      FROM sync_entity_heads WHERE entity_id = ?
    `).get(op.entity_id) as { entity_rev: string; operation_sha256: string } | undefined;
    if (head) {
      const order = compareCanonicalDecimals(op.entity_rev, head.entity_rev);
      if (order < 0) return 'stale';
      if (order === 0) {
        if (op.operation_sha256 !== head.operation_sha256) {
          throw invalidOp(op, 'same entity revision has a different canonical operation hash');
        }
        return 'stale';
      }
    }

    let outcome: 'applied' | 'stale';
    if (op.deleted === true) {
      const table = op.kind === 'observation'
        ? 'observations'
        : op.kind === 'summary'
          ? 'session_summaries'
          : 'user_prompts';
      this.db.prepare(
        `DELETE FROM ${table} WHERE origin_device_id = ? AND origin_local_id = ?`
      ).run(op.origin_device, op.origin_id);
      outcome = 'applied';
    } else {
      outcome = this.applyRowOp(op, chromaJobs);
    }

    this.db.prepare(`
      INSERT INTO sync_entity_heads
        (entity_id, kind, origin_device_id, origin_local_id, entity_rev,
         operation_sha256, deleted, updated_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        entity_rev=excluded.entity_rev,
        operation_sha256=excluded.operation_sha256,
        deleted=excluded.deleted,
        updated_at_epoch=excluded.updated_at_epoch
    `).run(
      op.entity_id, op.kind, op.origin_device, op.origin_id, op.entity_rev,
      op.operation_sha256, op.deleted === true ? 1 : 0, this.now(),
    );
    return outcome;
  }

  private applyRowOp(op: SyncOp, chromaJobs: ChromaJob[]): 'applied' | 'stale' {
    const body = this.parseBody(op);
    switch (op.kind) {
      case 'observation':
        return this.applyObservation(op, body, chromaJobs);
      case 'summary':
        return this.applySummary(op, body, chromaJobs);
      case 'prompt':
        return this.applyPrompt(op, body, chromaJobs);
      default:
        throw invalidOp(op, `unknown row kind`);
    }
  }

  // ------------------------------------------------------------------------
  // Title parking (see SET_TITLE CONVERGENCE in the module header)
  // ------------------------------------------------------------------------

  private static parkedTitleMemKey(memorySessionId: string): string {
    return `parked_title:mem:${memorySessionId}`;
  }

  private static parkedTitleContentKey(platform: string, contentSessionId: string): string {
    return `parked_title:content:${platform}:${contentSessionId}`;
  }

  private parkTitle(key: string, title: string): void {
    // Last parked title for an identity wins (log order — a later set_title
    // in the same replay overwrites the earlier one).
    this.db.prepare(`
      INSERT INTO sync_state (k, v) VALUES (?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v
    `).run(key, title);
  }

  /**
   * Apply a parked title to a session, if one is parked under `key`.
   * NULL-guarded like createSDKSession (SessionStore.ts:1922-1927): a title
   * that already landed (or a native title) is never overwritten by a
   * deferred claim. The parking entry is consumed either way.
   */
  private claimParkedTitle(sessionId: number, key: string): void {
    const parked = this.db.prepare('SELECT v FROM sync_state WHERE k = ?').get(key) as { v: string } | undefined;
    if (!parked) return;
    this.db.prepare(
      'UPDATE sdk_sessions SET custom_title = ? WHERE id = ? AND custom_title IS NULL'
    ).run(parked.v, sessionId);
    this.db.prepare('DELETE FROM sync_state WHERE k = ?').run(key);
  }

  /**
   * Ensure a local sdk_sessions row exists for a remote memory_session_id;
   * returns its local id. Creates a minimal stub when unknown (see module
   * header — FK is enforced and sessions do not sync). Every path through
   * here also claims any parked title for the identities it learns.
   */
  private ensureSessionForMemoryId(
    memorySessionId: string,
    project: string,
    createdAtEpoch: number,
    contentSessionId?: string | null,
    platformSource?: string | null
  ): number {
    const platform = normalizePlatformSource(platformSource ?? undefined);
    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { id: number } | undefined;
    if (existing) {
      // An op carrying the content↔memory association can satisfy a title
      // parked under the content key: obs-created stubs have a synthetic
      // content id, so the association first shows up here (via a prompt row
      // op or a set_prompt_session repair), not at stub creation.
      if (contentSessionId) {
        this.claimParkedTitle(existing.id, SyncApply.parkedTitleContentKey(platform, contentSessionId));
      }
      return existing.id;
    }

    const content = contentSessionId ?? memorySessionId;
    const iso = new Date(createdAtEpoch).toISOString();
    // ON CONFLICT on the (platform_source, content_session_id) identity
    // (migration v33): if a local session already claims this content id
    // under another memory id, adopt it instead of failing the batch.
    const inserted = this.db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, NULL, ?, ?, 'completed')
      ON CONFLICT(platform_source, content_session_id) DO NOTHING
      RETURNING id
    `).get(content, memorySessionId, project, platform, iso, createdAtEpoch) as { id: number } | null;

    let sessionId: number;
    if (inserted) {
      logger.debug('SYNC_APPLY', 'Created stub sdk_session for remote memory session', {
        memorySessionId,
        project,
      });
      sessionId = inserted.id;
    } else {
      const adopted = this.db.prepare(
        'SELECT id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?'
      ).get(platform, content) as { id: number } | undefined;
      if (!adopted) {
        throw new Error(`SyncApply: could not create or adopt a session for memory_session_id=${memorySessionId}`);
      }
      sessionId = adopted.id;
    }

    this.claimParkedTitle(sessionId, SyncApply.parkedTitleMemKey(memorySessionId));
    if (contentSessionId) {
      this.claimParkedTitle(sessionId, SyncApply.parkedTitleContentKey(platform, contentSessionId));
    }
    return sessionId;
  }

  private applyObservation(op: SyncOp, body: Record<string, unknown>, chromaJobs: ChromaJob[]): 'applied' | 'stale' {
    const memorySessionId = fieldString(op, body, 'memory_session_id');
    const project = fieldString(op, body, 'project');
    const type = fieldString(op, body, 'type');
    const createdAtEpoch = fieldNumber(op, body, 'created_at_epoch');
    if (!memorySessionId || !project || !type || createdAtEpoch === null) {
      throw invalidOp(op, 'observation body requires memory_session_id, project, type, created_at_epoch');
    }
    const createdAt = fieldString(op, body, 'created_at') ?? new Date(createdAtEpoch).toISOString();

    const existing = this.findByOrigin('observations', op.origin_device, op.origin_id);
    if (existing) {
      if (compareCanonicalDecimals(op.rev, existing.sync_rev) <= 0) return 'stale';
      this.ensureSessionForMemoryId(memorySessionId, project, createdAtEpoch); // FK holds even if the body re-homed the row
      this.db.prepare(`
        UPDATE observations SET
          memory_session_id = ?, project = ?, text = ?, type = ?, title = ?, subtitle = ?,
          facts = ?, narrative = ?, concepts = ?, files_read = ?, files_modified = ?,
          prompt_number = ?, discovery_tokens = ?, content_hash = ?, generated_by_model = ?,
          agent_type = ?, agent_id = ?, metadata = ?, merged_into_project = ?,
          created_at = ?, created_at_epoch = ?, sync_rev = ?, synced_at = ?
        WHERE id = ?
      `).run(
        memorySessionId, project, fieldString(op, body, 'text'), type, fieldString(op, body, 'title'), fieldString(op, body, 'subtitle'),
        fieldString(op, body, 'facts'), fieldString(op, body, 'narrative'), fieldString(op, body, 'concepts'), fieldString(op, body, 'files_read'), fieldString(op, body, 'files_modified'),
        fieldNumber(op, body, 'prompt_number'), fieldNumber(op, body, 'discovery_tokens') ?? 0, fieldString(op, body, 'content_hash'), fieldString(op, body, 'generated_by_model'),
        fieldString(op, body, 'agent_type'), fieldString(op, body, 'agent_id'), fieldString(op, body, 'metadata'), fieldString(op, body, 'merged_into_project'),
        createdAt, createdAtEpoch, op.rev, this.now(),
        existing.id
      );
      return 'applied';
    }

    this.ensureSessionForMemoryId(memorySessionId, project, createdAtEpoch);
    // synced_at is pre-stamped (NEVER NULL on an applied row) — the push
    // drain's WHERE synced_at IS NULL structurally cannot re-push this row.
    // ON CONFLICT on the content-hash identity (migration v29): identical
    // content already present under another identity is a skip, not a crash.
    const inserted = this.db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, generated_by_model,
         agent_type, agent_id, metadata, merged_into_project, created_at, created_at_epoch,
         synced_at, origin_device_id, origin_local_id, sync_rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id
    `).get(
      memorySessionId, project, fieldString(op, body, 'text'), type, fieldString(op, body, 'title'), fieldString(op, body, 'subtitle'),
      fieldString(op, body, 'facts'), fieldString(op, body, 'narrative'), fieldString(op, body, 'concepts'), fieldString(op, body, 'files_read'), fieldString(op, body, 'files_modified'),
      fieldNumber(op, body, 'prompt_number'), fieldNumber(op, body, 'discovery_tokens') ?? 0, fieldString(op, body, 'content_hash'), fieldString(op, body, 'generated_by_model'),
      fieldString(op, body, 'agent_type'), fieldString(op, body, 'agent_id'), fieldString(op, body, 'metadata'), fieldString(op, body, 'merged_into_project'),
      createdAt, createdAtEpoch,
      this.now(), op.origin_device, op.origin_id, op.rev
    ) as { id: number } | null;

    if (!inserted) {
      logger.debug('SYNC_APPLY', 'Remote observation content already present locally (content-hash dupe); skipped', {
        originDevice: op.origin_device,
        originId: op.origin_id,
      });
      return 'stale';
    }

    if (this.chromaSync) {
      const chroma = this.chromaSync;
      const id = inserted.id;
      chromaJobs.push(() => chroma.syncObservation(
        id,
        memorySessionId,
        project,
        {
          type,
          title: fieldString(op, body, 'title'),
          subtitle: fieldString(op, body, 'subtitle'),
          facts: parseListColumn(body.facts),
          narrative: fieldString(op, body, 'narrative'),
          concepts: parseListColumn(body.concepts),
          files_read: parseListColumn(body.files_read),
          files_modified: parseListColumn(body.files_modified),
        },
        fieldNumber(op, body, 'prompt_number') ?? 0,
        createdAtEpoch
      ));
    }
    return 'applied';
  }

  private applySummary(op: SyncOp, body: Record<string, unknown>, chromaJobs: ChromaJob[]): 'applied' | 'stale' {
    const memorySessionId = fieldString(op, body, 'memory_session_id');
    const project = fieldString(op, body, 'project');
    const createdAtEpoch = fieldNumber(op, body, 'created_at_epoch');
    if (!memorySessionId || !project || createdAtEpoch === null) {
      throw invalidOp(op, 'summary body requires memory_session_id, project, created_at_epoch');
    }
    const createdAt = fieldString(op, body, 'created_at') ?? new Date(createdAtEpoch).toISOString();

    const existing = this.findByOrigin('session_summaries', op.origin_device, op.origin_id);
    if (existing) {
      if (compareCanonicalDecimals(op.rev, existing.sync_rev) <= 0) return 'stale';
      this.ensureSessionForMemoryId(memorySessionId, project, createdAtEpoch); // FK holds even if the body re-homed the row
      this.db.prepare(`
        UPDATE session_summaries SET
          memory_session_id = ?, project = ?, request = ?, investigated = ?, learned = ?, completed = ?,
          next_steps = ?, files_read = ?, files_edited = ?, notes = ?, prompt_number = ?,
          discovery_tokens = ?, merged_into_project = ?, created_at = ?, created_at_epoch = ?,
          sync_rev = ?, synced_at = ?
        WHERE id = ?
      `).run(
        memorySessionId, project, fieldString(op, body, 'request'), fieldString(op, body, 'investigated'), fieldString(op, body, 'learned'), fieldString(op, body, 'completed'),
        fieldString(op, body, 'next_steps'), fieldString(op, body, 'files_read'), fieldString(op, body, 'files_edited'), fieldString(op, body, 'notes'), fieldNumber(op, body, 'prompt_number'),
        fieldNumber(op, body, 'discovery_tokens') ?? 0, fieldString(op, body, 'merged_into_project'), createdAt, createdAtEpoch,
        op.rev, this.now(),
        existing.id
      );
      return 'applied';
    }

    this.ensureSessionForMemoryId(memorySessionId, project, createdAtEpoch);
    const inserted = this.db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, project, request, investigated, learned, completed, next_steps,
         files_read, files_edited, notes, prompt_number, discovery_tokens, merged_into_project,
         created_at, created_at_epoch, synced_at, origin_device_id, origin_local_id, sync_rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      memorySessionId, project, fieldString(op, body, 'request'), fieldString(op, body, 'investigated'), fieldString(op, body, 'learned'), fieldString(op, body, 'completed'),
      fieldString(op, body, 'next_steps'), fieldString(op, body, 'files_read'), fieldString(op, body, 'files_edited'), fieldString(op, body, 'notes'), fieldNumber(op, body, 'prompt_number'),
      fieldNumber(op, body, 'discovery_tokens') ?? 0, fieldString(op, body, 'merged_into_project'),
      createdAt, createdAtEpoch, this.now(), op.origin_device, op.origin_id, op.rev
    ) as { id: number };

    if (this.chromaSync) {
      const chroma = this.chromaSync;
      const id = inserted.id;
      chromaJobs.push(() => chroma.syncSummary(
        id,
        memorySessionId,
        project,
        {
          request: fieldString(op, body, 'request'),
          investigated: fieldString(op, body, 'investigated'),
          learned: fieldString(op, body, 'learned'),
          completed: fieldString(op, body, 'completed'),
          next_steps: fieldString(op, body, 'next_steps'),
          notes: fieldString(op, body, 'notes'),
        },
        fieldNumber(op, body, 'prompt_number') ?? 0,
        createdAtEpoch
      ));
    }
    return 'applied';
  }

  /** Resolve the local sdk_sessions id for a remote prompt, or NULL (orphan). */
  private resolvePromptSession(op: SyncOp, body: Record<string, unknown>, createdAtEpoch: number): number | null {
    const memorySessionId = fieldString(op, body, 'memory_session_id');
    if (memorySessionId) {
      return this.ensureSessionForMemoryId(
        memorySessionId,
        fieldString(op, body, 'project') ?? 'unknown',
        createdAtEpoch,
        fieldString(op, body, 'content_session_id'),
        fieldString(op, body, 'platform_source')
      );
    }
    // No memory id on the origin yet (prompt captured before registration) —
    // link only if a matching local session already exists; otherwise orphan
    // (session_db_id is nullable and the set_prompt_session repair op links
    // it once the origin registers).
    const contentSessionId = fieldString(op, body, 'content_session_id');
    if (!contentSessionId) return null;
    const platform = normalizePlatformSource(fieldString(op, body, 'platform_source') ?? undefined);
    const row = this.db.prepare(`
      SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?
      LIMIT 1
    `).get(DEFAULT_PLATFORM_SOURCE, platform, contentSessionId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private applyPrompt(op: SyncOp, body: Record<string, unknown>, chromaJobs: ChromaJob[]): 'applied' | 'stale' {
    const contentSessionId = fieldString(op, body, 'content_session_id');
    const promptNumber = fieldNumber(op, body, 'prompt_number');
    const promptText = fieldString(op, body, 'prompt_text');
    const createdAtEpoch = fieldNumber(op, body, 'created_at_epoch');
    if (!contentSessionId || promptNumber === null || promptText === null || createdAtEpoch === null) {
      throw invalidOp(op, 'prompt body requires content_session_id, prompt_number, prompt_text, created_at_epoch');
    }
    const createdAt = fieldString(op, body, 'created_at') ?? new Date(createdAtEpoch).toISOString();

    const existing = this.findByOrigin('user_prompts', op.origin_device, op.origin_id);
    if (existing) {
      if (compareCanonicalDecimals(op.rev, existing.sync_rev) <= 0) return 'stale';
      const sessionDbId = this.resolvePromptSession(op, body, createdAtEpoch);
      this.db.prepare(`
        UPDATE user_prompts SET
          session_db_id = ?, content_session_id = ?, prompt_number = ?, prompt_text = ?,
          created_at = ?, created_at_epoch = ?, sync_rev = ?, synced_at = ?
        WHERE id = ?
      `).run(
        sessionDbId, contentSessionId, promptNumber, promptText,
        createdAt, createdAtEpoch, op.rev, this.now(),
        existing.id
      );
      return 'applied';
    }

    const sessionDbId = this.resolvePromptSession(op, body, createdAtEpoch);
    const inserted = this.db.prepare(`
      INSERT INTO user_prompts
        (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch,
         synced_at, origin_device_id, origin_local_id, sync_rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      sessionDbId, contentSessionId, promptNumber, promptText, createdAt, createdAtEpoch,
      this.now(), op.origin_device, op.origin_id, op.rev
    ) as { id: number };

    if (this.chromaSync) {
      const chroma = this.chromaSync;
      const id = inserted.id;
      chromaJobs.push(() => chroma.syncUserPrompt(
        id,
        fieldString(op, body, 'memory_session_id') ?? contentSessionId,
        fieldString(op, body, 'project') ?? 'unknown',
        promptText,
        promptNumber,
        createdAtEpoch,
        fieldString(op, body, 'platform_source') ?? undefined
      ));
    }
    return 'applied';
  }

  // -------------------------------------------------------------------------
  // Mutation ops
  // -------------------------------------------------------------------------

  private applyMutation(op: SyncOp): 'applied' | 'stale' {
    const body = this.parseBody(op);
    const mutationOp = fieldString(op, body, 'op');
    switch (mutationOp) {
      case 'set_title':
        return this.applySetTitle(op, body);
      case 'set_prompt_session':
        return this.applySetPromptSession(op, body);
      case 'remap_project':
        return this.applyRemapProject(op, body);
      default:
        throw invalidOp(op, `unknown mutation op ${String(body.op)}`);
    }
  }

  /**
   * set_title resolution (three steps — see SET_TITLE CONVERGENCE in the
   * module header): direct session match → via a replicated prompt's content
   * id → park in sync_state for a later claim. sdk_sessions carries no
   * sync_rev (v41 touches only the synced tables), so rev is never
   * consulted: direct applications overwrite in hub-log order; parked
   * claims fill only a NULL custom_title.
   */
  private applySetTitle(op: SyncOp, body: Record<string, unknown>): 'applied' | 'stale' {
    const target = body.target as Record<string, unknown> | undefined;
    const fields = body.fields as Record<string, unknown> | undefined;
    if (!target || typeof target !== 'object' || Array.isArray(target) || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw invalidOp(op, 'set_title requires target and fields objects');
    }
    const customTitle = fieldString(op, fields, 'custom_title');
    if (customTitle === null) {
      throw invalidOp(op, 'set_title requires fields.custom_title');
    }

    // NOTE: every branch here is SELECT-then-UPDATE-by-id, never a decision
    // on `.run().changes` — bun:sqlite (1.3.9) has been observed reporting a
    // bogus non-zero `changes` for a zero-match UPDATE when it follows a
    // RETURNING statement inside the same transaction on this connection
    // (reported 4 with a verified 0 matching rows), which silently misroutes
    // apply-vs-park. SELECTs in our transaction are authoritative.
    const memorySessionId = fieldString(op, target, 'memory_session_id');
    if (memorySessionId) {
      const session = this.db.prepare(
        'SELECT id FROM sdk_sessions WHERE memory_session_id = ?'
      ).get(memorySessionId) as { id: number } | undefined;
      if (session) {
        this.db.prepare('UPDATE sdk_sessions SET custom_title = ? WHERE id = ?')
          .run(customTitle, session.id);
        return 'applied';
      }
      // No such session yet — park until ensureSessionForMemoryId creates it.
      this.parkTitle(SyncApply.parkedTitleMemKey(memorySessionId), customTitle);
      return 'applied';
    }

    const contentSessionId = fieldString(op, target, 'content_session_id');
    if (!contentSessionId) {
      throw invalidOp(op, 'set_title target requires memory_session_id or content_session_id');
    }
    const platform = normalizePlatformSource(fieldString(op, target, 'platform_source') ?? undefined);

    // (1) Direct match on the session identity.
    const direct = this.db.prepare(`
      SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?
      LIMIT 1
    `).get(DEFAULT_PLATFORM_SOURCE, platform, contentSessionId) as { id: number } | undefined;
    if (direct) {
      this.db.prepare('UPDATE sdk_sessions SET custom_title = ? WHERE id = ?')
        .run(customTitle, direct.id);
      return 'applied';
    }

    // (2) Via a replicated prompt: when row ops arrived first, the
    // observation-created stub carries a synthetic content id, but any
    // replicated prompt knows its real content_session_id AND its local
    // session link.
    const viaPrompt = this.db.prepare(`
      SELECT session_db_id FROM user_prompts
      WHERE content_session_id = ? AND session_db_id IS NOT NULL
      LIMIT 1
    `).get(contentSessionId) as { session_db_id: number } | undefined;
    if (viaPrompt) {
      this.db.prepare('UPDATE sdk_sessions SET custom_title = ? WHERE id = ?')
        .run(customTitle, viaPrompt.session_db_id);
      return 'applied';
    }

    // (3) Park — claimed when the session (or the content↔memory
    // association) shows up. Genuine hub-log order is [set_title, row ops…],
    // so this is the COMMON path on a device that has never seen the session.
    this.parkTitle(SyncApply.parkedTitleContentKey(platform, contentSessionId), customTitle);
    return 'applied';
  }

  private applySetPromptSession(op: SyncOp, body: Record<string, unknown>): 'applied' | 'stale' {
    const target = body.target as Record<string, unknown> | undefined;
    const fields = body.fields as Record<string, unknown> | undefined;
    const targetDevice = target ? fieldString(op, target, 'origin_device_id') : null;
    const targetLocalId = target ? fieldString(op, target, 'origin_local_id') : null;
    const memorySessionId = fields ? fieldString(op, fields, 'memory_session_id') : null;
    if (!targetDevice || !targetLocalId || !memorySessionId) {
      throw invalidOp(op, 'set_prompt_session requires target.origin_device_id, target.origin_local_id, fields.memory_session_id');
    }

    // Origin identity match: a row that originated HERE is a native row
    // (origin columns NULL, origin_local_id is its rowid); anywhere else it
    // is a replica keyed by the origin pair.
    const row = (targetDevice === this.deviceId
      ? this.db.prepare(
          `SELECT id, CAST(sync_rev AS TEXT) AS sync_rev
           FROM user_prompts WHERE origin_device_id IS NULL AND id = ?`
        ).get(targetLocalId)
      : this.db.prepare(
          `SELECT id, CAST(sync_rev AS TEXT) AS sync_rev
           FROM user_prompts WHERE origin_device_id = ? AND origin_local_id = ?`
        ).get(targetDevice, targetLocalId)) as RowIdRev | undefined;
    if (!row) return 'stale'; // row not replicated here (yet) — nothing to repair
    if (compareCanonicalDecimals(op.rev, row.sync_rev) < 0) return 'stale'; // stale mutation

    const sessionDbId = this.ensureSessionForMemoryId(
      memorySessionId,
      (fields && fieldString(op, fields, 'project')) ?? 'unknown',
      op.server_ts,
      fields ? fieldString(op, fields, 'content_session_id') : null,
      fields ? fieldString(op, fields, 'platform_source') : null
    );
    // synced_at deliberately untouched: the repair travels through the log
    // itself, so applying it must not queue a re-push (echo guard).
    this.db.prepare(
      'UPDATE user_prompts SET session_db_id = ?, sync_rev = ? WHERE id = ?'
    ).run(sessionDbId, op.rev, row.id);
    return 'applied';
  }

  private applyRemapProject(op: SyncOp, body: Record<string, unknown>): 'applied' | 'stale' {
    const where = body.where as Record<string, unknown> | undefined;
    const fields = body.fields as Record<string, unknown> | undefined;
    if (!where || typeof where !== 'object' || !fields || typeof fields !== 'object') {
      throw invalidOp(op, 'remap_project requires where and fields objects');
    }

    const setClauses: string[] = [];
    const setParams: (string | number)[] = [];
    const newProject = fieldString(op, fields, 'project');
    const mergedInto = fieldString(op, fields, 'merged_into_project');
    if (newProject !== null) {
      setClauses.push('project = ?');
      setParams.push(newProject);
    }
    if (mergedInto !== null) {
      setClauses.push('merged_into_project = ?');
      setParams.push(mergedInto);
    }
    if (setClauses.length === 0) {
      throw invalidOp(op, 'remap_project fields must set project and/or merged_into_project');
    }

    const whereClauses: string[] = [];
    const whereParams: (string | number)[] = [];
    const whereProject = fieldString(op, where, 'project');
    const whereMemorySessionId = fieldString(op, where, 'memory_session_id');
    if (whereProject !== null) {
      whereClauses.push('project = ?');
      whereParams.push(whereProject);
    }
    if (whereMemorySessionId !== null) {
      whereClauses.push('memory_session_id = ?');
      whereParams.push(whereMemorySessionId);
    }
    if (where.merged_into_project_is_null === true) {
      whereClauses.push('merged_into_project IS NULL');
    }
    if (whereClauses.length === 0) {
      // Refuse an unbounded remap outright — a predicate-free UPDATE across
      // the whole corpus is never intentional.
      throw invalidOp(op, 'remap_project where predicate is empty');
    }

    // Rev guard per matched row: apply only where op.rev >= sync_rev, and
    // stamp sync_rev = op.rev on the rows actually remapped (op.rev is the
    // max by the guard). synced_at untouched — the remap travels via the log.
    //
    // The applied/stale outcome comes from COUNT-then-UPDATE, never from
    // `.run().changes` — see the note in applySetTitle (bun:sqlite reports
    // unreliable `changes` after RETURNING statements in the same
    // transaction). Both statements see identical in-transaction state.
    let matched = 0;
    for (const table of ['observations', 'session_summaries']) {
      const rows = this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM ${table} WHERE ${whereClauses.join(' AND ')}
      `).all(...whereParams) as Array<{ id: string; sync_rev: string }>;
      for (const row of rows) {
        if (compareCanonicalDecimals(op.rev, row.sync_rev) < 0) continue;
        this.db.prepare(`
          UPDATE ${table} SET ${setClauses.join(', ')}, sync_rev = ? WHERE id = ?
        `).run(...setParams, op.rev, row.id);
        matched++;
      }
    }
    // The cwd-remap shape (ProcessManager.ts:312-314) also retargets the
    // owning session row; sdk_sessions has no sync_rev — log order wins.
    if (newProject !== null && whereMemorySessionId !== null) {
      const session = this.db.prepare(
        'SELECT id FROM sdk_sessions WHERE memory_session_id = ?'
      ).get(whereMemorySessionId) as { id: number } | undefined;
      if (session) {
        this.db.prepare('UPDATE sdk_sessions SET project = ? WHERE id = ?')
          .run(newProject, session.id);
        matched += 1;
      }
    }
    return matched > 0 ? 'applied' : 'stale';
  }
}
