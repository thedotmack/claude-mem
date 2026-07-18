// Worker-native cloud sync push drain — the database is the queue.
//
// Every memory row carries a `synced_at` column (NULL = not in the hub's log;
// migration v36/v39). Write sites nudge `notify()` after each local write; a
// trailing debounce coalesces bursts into one `flush()`, which drains
// `WHERE synced_at IS NULL AND origin_device_id IS NULL` in batches, POSTs to
// the per-user sync hub (workers/sync-hub), and stamps rows on ack. That
// single mechanism IS live sync, backfill, offline catch-up, and retry — no
// second process, no cursor files. Mutation ops (custom title, prompt→session
// repair, project remaps) ride the same flush from the `sync_outbox` table
// (migration v42), drained FIRST so the hub log carries them before the row
// ops they relate to (SyncApply's title parking relies on that order).
//
// WIRE CONTRACT (Phase 3 retarget — the old per-kind cmem.ai endpoints, their
// `toCloud` mappers, the stampGuard machinery, and the live|backfill lane are
// DELETED): one endpoint, POST {hubUrl}/v1/sync/ops with
// `{ops: [{kind, origin_id, rev, body}]}` → `{acked: [{kind, origin_id, rev,
// seq}], head_seq}` (workers/sync-hub/src/index.ts). Row op bodies follow the
// BODY FIELD MAPPING in SyncApply.ts verbatim: field names are the local
// column names, values exactly as stored (JSON-string columns stay JSON
// strings), exclusions as listed there. origin_id = String(local rowid) for
// rows, the queued op UUID for mutations; rev = the row's sync_rev / the
// queued op's rev.
//
// STAMPING (replaces stampGuardSql): acks are matched by (kind, origin_id,
// rev) — the hub may return them in any order, and duplicate-in-batch keys
// share a seq. A row is stamped ONLY where its CURRENT sync_rev still equals
// the acked rev, so a mutation site bumping sync_rev while a POST is in
// flight (e.g. requeuePromptSync registering a memory id) leaves the row
// unsynced and the same flush loop re-pushes it corrected at the higher rev.
// Acked mutation ops are DELETEd from sync_outbox (queue entries, not data).
//
// SIZE CLAMPS: real-world user_prompts carry multi-MB text (observed single
// 7.4MB prompts from pasted logs), so prompt_text is clamped IN SQL (200KB +
// marker), every string field is clamped to 200KB — INCLUDING mutation
// envelope fields (custom_title enters via an unbounded z.string(); a
// size-refused mutation would 400 the whole batch and wedge the push lane
// forever, since drainMutations runs first) — request bodies are packed
// under 2MB (hub cap: 8MB/request, ≤500 ops), and any op whose serialized
// form would still exceed the hub's per-op limit (1,990,000 bytes) gets a
// hard 60KB-per-field re-clamp. The invariant holds for ALL kinds: an op
// that leaves here cannot be refused for size.
//
// LIVELOCK GUARD: the drain loops make forward progress ONLY via acks
// (stamp/DELETE). A 200 response that fails to ack every pushed op would
// otherwise re-SELECT and re-POST the same rows at network RTT forever with
// no error surfaced — so sendOps treats any un-acked pushed op as a push
// failure (after stamping the acks that DID arrive) and throws into the
// normal backoff path.

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';

// Page size for the drain SELECTs.
const BATCH = 200;
// Request-body packing budget — well under the hub's 8,000,000-byte cap.
const MAX_BODY_BYTES = 2_000_000;
// Hub cap: ≤500 ops per POST /v1/sync/ops request.
const MAX_OPS_PER_PUSH = 500;
// Hub per-op body backstop is 1,990,000 bytes (SyncHub MAX_BODY_BYTES); the
// client clamp sits below it so a locally built op can never be refused.
const MAX_OP_BYTES = 1_900_000;
export const MAX_FIELD_BYTES = 200_000;
// Emergency per-field bound when a clamped op would STILL exceed MAX_OP_BYTES
// (only reachable with ~10 maxed 200KB fields in one row — pathological).
const HARD_FIELD_BYTES = 60_000;
export const TRUNC_MARK = '\n…[truncated by cloud-sync: field exceeded 200KB]';

type LocalRow = Record<string, unknown> & { id: number; sync_rev: number };
type OpBody = Record<string, unknown>;

type RowKind = 'observation' | 'summary' | 'prompt';

interface WireOp {
  kind: RowKind | 'mutation';
  origin_id: string;
  rev: number;
  body: OpBody;
}

interface AckedOp {
  kind: string;
  origin_id: string;
  rev: number;
  seq: number;
}

interface PushResponse {
  acked: AckedOp[];
  head_seq: number;
}

const TABLE_BY_KIND: Record<RowKind, string> = {
  observation: 'observations',
  summary: 'session_summaries',
  prompt: 'user_prompts',
};

interface KindSpec {
  kind: RowKind;
  localTable: string;
  /**
   * Drain SELECT: unsynced NATIVE rows only. Replica rows (origin_device_id
   * NOT NULL) are another device's corpus — pushing them under this device's
   * identity would fork origin attribution, so they are excluded here even
   * if something re-nulls their synced_at.
   */
  selectSql: string;
  /** Op body per the SyncApply BODY FIELD MAPPING — values exactly as stored. */
  toBody: (r: LocalRow) => OpBody;
}

const KINDS: KindSpec[] = [
  {
    kind: 'observation',
    localTable: 'observations',
    selectSql: `
      SELECT id, sync_rev, memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified, prompt_number,
        discovery_tokens, content_hash, generated_by_model, agent_type, agent_id,
        metadata, merged_into_project, created_at, created_at_epoch
      FROM observations
      WHERE synced_at IS NULL AND origin_device_id IS NULL
      ORDER BY id LIMIT ${BATCH}`,
    toBody: (r) => ({
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? null,
      text: r.text ?? null,
      type: r.type ?? null,
      title: r.title ?? null,
      subtitle: r.subtitle ?? null,
      facts: r.facts ?? null,
      narrative: r.narrative ?? null,
      concepts: r.concepts ?? null,
      files_read: r.files_read ?? null,
      files_modified: r.files_modified ?? null,
      prompt_number: r.prompt_number ?? null,
      discovery_tokens: r.discovery_tokens ?? 0,
      content_hash: r.content_hash ?? null,
      generated_by_model: r.generated_by_model ?? null,
      agent_type: r.agent_type ?? null,
      agent_id: r.agent_id ?? null,
      metadata: r.metadata ?? null,
      merged_into_project: r.merged_into_project ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: r.created_at_epoch ?? null,
    }),
  },
  {
    kind: 'summary',
    localTable: 'session_summaries',
    selectSql: `
      SELECT id, sync_rev, memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes, prompt_number,
        discovery_tokens, merged_into_project, created_at, created_at_epoch
      FROM session_summaries
      WHERE synced_at IS NULL AND origin_device_id IS NULL
      ORDER BY id LIMIT ${BATCH}`,
    toBody: (r) => ({
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? null,
      request: r.request ?? null,
      investigated: r.investigated ?? null,
      learned: r.learned ?? null,
      completed: r.completed ?? null,
      next_steps: r.next_steps ?? null,
      files_read: r.files_read ?? null,
      files_edited: r.files_edited ?? null,
      notes: r.notes ?? null,
      prompt_number: r.prompt_number ?? null,
      discovery_tokens: r.discovery_tokens ?? 0,
      merged_into_project: r.merged_into_project ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: r.created_at_epoch ?? null,
    }),
  },
  {
    kind: 'prompt',
    localTable: 'user_prompts',
    // prompt_text is clamped IN SQL (observed single prompts of 7.4MB from
    // pasted logs): truncating after .all() still materializes the giant
    // strings and OOMs the process, so never let them cross the FFI boundary.
    // memory_session_id/project/platform_source resolve through the same
    // sdk_sessions LEFT JOIN the local viewer uses (SyncApply BODY FIELD
    // MAPPING, kind 'prompt'); they are nullable — the apply side links
    // orphans later via set_prompt_session. session_db_id NEVER travels (a
    // device-local rowid, re-resolved on apply).
    //
    // ACCEPTED LIMITATION (join-field drift): the body embeds JOINED session
    // fields, but the op's rev covers only the prompt row itself — a later
    // change to the owning session (e.g. a project remap) does not bump
    // prompt revs or re-push prompts, so replicas' embedded copies can lag.
    // Divergence is corrected by the mutation lane (remap_project /
    // set_prompt_session predicates), not the prompt row lane.
    selectSql: `
      SELECT up.id AS id, up.sync_rev AS sync_rev,
        up.content_session_id AS content_session_id,
        up.prompt_number AS prompt_number,
        substr(up.prompt_text, 1, ${MAX_FIELD_BYTES}) AS prompt_text,
        length(up.prompt_text) AS prompt_text_len,
        up.created_at AS created_at, up.created_at_epoch AS created_at_epoch,
        s.memory_session_id AS memory_session_id, s.project AS project,
        s.platform_source AS platform_source
      FROM user_prompts up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.synced_at IS NULL AND up.origin_device_id IS NULL
      ORDER BY up.id LIMIT ${BATCH}`,
    toBody: (r) => ({
      content_session_id: r.content_session_id ?? null,
      prompt_number: r.prompt_number ?? null,
      prompt_text: r.prompt_text != null && (r.prompt_text_len as number) > MAX_FIELD_BYTES
        ? String(r.prompt_text) + TRUNC_MARK
        : r.prompt_text ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: r.created_at_epoch ?? null,
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? null,
      platform_source: r.platform_source ?? null,
    }),
  },
];

/** Clamp every string field of an op body to `maxField` bytes-ish (chars). */
function clampFields(body: OpBody, maxField: number): OpBody {
  const out = { ...body };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > maxField) {
      out[k] = v.slice(0, maxField) + TRUNC_MARK;
    }
  }
  return out;
}

/**
 * Clamp a mutation envelope ({op, target|where, fields} — one level of
 * nesting, flat string values inside). custom_title enters via an unbounded
 * z.string() (SessionRoutes), and a single size-refused mutation 400s the
 * WHOLE push request, wedging the lane forever (drainMutations runs first).
 * Identity fields (target/where) are clamped too: a >200KB "identity" could
 * never match a real row anyway, and leaving it unclamped would keep the
 * refusal alive.
 */
function clampMutationBody(body: OpBody, maxField: number): OpBody {
  const out: OpBody = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.length > maxField) {
      out[k] = v.slice(0, maxField) + TRUNC_MARK;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = clampFields(v as OpBody, maxField);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type CloudSyncSettingKeys = Pick<SettingsDefaults,
  | 'CLAUDE_MEM_CLOUD_SYNC_TOKEN'
  | 'CLAUDE_MEM_CLOUD_SYNC_USER_ID'
  | 'CLAUDE_MEM_CLOUD_SYNC_HUB_URL'
  | 'CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID'
  | 'CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME'
>;

export interface CloudSyncOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** settings.json path where a newly resolved device id is persisted. */
  settingsPath?: string;
  /** Legacy standalone-client state file (~/.claude-mem/cloud-sync-state.json). */
  legacyStatePath?: string;
  /** Trailing debounce for notify() bursts. */
  debounceMs?: number;
  /**
   * Debounce while the advisory socket is live (plan Phase 4 task 3): with
   * WS fan-out the hub push IS delivery, so the debounce dominates
   * cross-device latency — 1500 ms drops to 250 ms. Toggled via
   * setFastDebounce() by SyncClient's socket-liveness callback.
   */
  fastDebounceMs?: number;
  /** First retry delay after a failed flush; doubles up to backoffMaxMs. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Per-request timeout — a hub POST can never hang the drain. */
  requestTimeoutMs?: number;
}

export interface CloudSyncStatus {
  configured: boolean;
  deviceId: string;
  pending: { observations: number; summaries: number; prompts: number; mutations: number };
  lastFlushAt: number | null;
  lastError: string | null;
}

export class CloudSync {
  private readonly db: Database;
  private readonly token: string;
  private readonly userId: string;
  private readonly hubUrl: string;
  private readonly deviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly settingsPath: string;
  private readonly legacyStatePath: string;
  private readonly debounceMs: number;
  private readonly fastDebounceMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly requestTimeoutMs: number;

  /** '' when unconfigured or when device-id resolution failed closed. */
  private deviceId = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextBackoffMs: number;
  private flushing = false;
  private flushAgainRequested = false;
  private stopped = false;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;
  /** True while SyncClient's advisory socket is live (setFastDebounce). */
  private fastDebounce = false;
  /**
   * head_seq piggyback (plan Phase 3 task 3): every push response carries the
   * hub's head_seq; SyncClient registers here so a push that reveals unseen
   * remote ops triggers a pull without waiting for the poll timer.
   */
  private headSeqListener: ((headSeq: number) => void) | null = null;

  constructor(db: Database, settings: CloudSyncSettingKeys, options: CloudSyncOptions = {}) {
    this.db = db;
    this.token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN ?? '';
    this.userId = settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID ?? '';
    // Hard cutover (plan Phase 3 task 5, open decision 2): the hub URL has NO
    // default. Empty ⇒ sync is OFF entirely — there is no legacy per-kind
    // fallback lane.
    this.hubUrl = (settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '').trim().replace(/\/+$/, '');
    // Human-readable device label for the dashboard's Devices panel.
    this.deviceName = (settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME || hostname() || '').slice(0, 80);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.legacyStatePath = options.legacyStatePath ?? paths.cloudSyncState();
    this.debounceMs = options.debounceMs ?? 1_500;
    this.fastDebounceMs = options.fastDebounceMs ?? 250;
    this.backoffInitialMs = options.backoffInitialMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 600_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.nextBackoffMs = this.backoffInitialMs;

    if (this.isConfigured()) {
      this.deviceId = this.resolveDeviceId(settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '');
    }
  }

  /** Active ⇔ token AND user id AND hub URL are all non-empty. */
  isConfigured(): boolean {
    return this.token !== '' && this.userId !== '' && this.hubUrl !== '';
  }

  /** Configured AND holding a usable device id (resolution can fail closed). */
  private isActive(): boolean {
    return this.isConfigured() && this.deviceId !== '';
  }

  /** SyncClient wiring: called with head_seq after every successful push. */
  setHeadSeqListener(listener: ((headSeq: number) => void) | null): void {
    this.headSeqListener = listener;
  }

  /**
   * SyncClient wiring (plan Phase 4 task 3): while the advisory socket is
   * live the push debounce drops to fastDebounceMs (250 ms) — fan-out makes
   * the push itself the delivery, so the debounce dominates latency. Wrong
   * in either direction is harmless: it only changes WHEN a flush runs.
   */
  setFastDebounce(fast: boolean): void {
    this.fastDebounce = fast === true;
  }

  /**
   * Kick one flush (non-blocking). This IS backfill: a never-synced install
   * simply has everything `synced_at IS NULL`.
   */
  start(): void {
    if (!this.isActive()) {
      logger.debug('CLOUD_SYNC', 'Cloud sync inactive; start() skipped', {
        configured: this.isConfigured(),
        tokenLength: this.token.length, // never the token itself
      });
      return;
    }
    logger.info('CLOUD_SYNC', 'Cloud sync active — kicking startup drain', {
      hubUrl: this.hubUrl,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      tokenLength: this.token.length, // never the token itself
    });
    void this.flush();
  }

  /**
   * Write-site nudge. Trailing debounce coalesces write bursts into one
   * flush. Must never block or throw into the caller's write path.
   */
  notify(): void {
    try {
      if (this.stopped || !this.isActive()) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      const timer = setTimeout(() => {
        this.debounceTimer = null;
        void this.flush();
      }, this.fastDebounce ? this.fastDebounceMs : this.debounceMs);
      (timer as { unref?: () => void }).unref?.();
      this.debounceTimer = timer;
    } catch (error) {
      // notify() is called from write paths — swallow everything.
      try {
        logger.debug('CLOUD_SYNC', 'notify() failed (non-blocking)', {}, error instanceof Error ? error : new Error(String(error)));
      } catch { /* logging must never propagate into a write path */ }
    }
  }

  /**
   * Drain everything unsynced — mutation ops first (hub-log ordering: a
   * set_title enqueued at session creation must precede that session's row
   * ops), then the three row kinds. Single-flight: a flush arriving while
   * one is running marks a re-run instead of overlapping, so rows written
   * mid-flush are still picked up. Never rejects.
   */
  async flush(): Promise<void> {
    if (this.stopped || !this.isActive()) return;
    if (this.flushing) {
      this.flushAgainRequested = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgainRequested = false;
        await this.drainMutations();
        for (const kind of KINDS) {
          await this.drainKind(kind);
        }
      } while (this.flushAgainRequested && !this.stopped);
      if (this.stopped) return; // shutdown mid-flush — skip success bookkeeping
      this.lastFlushAt = Date.now();
      this.lastError = null;
      this.resetBackoff();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err.message;
      // Rows stay NULL — retried by the backoff timer below and on next notify().
      logger.warn('CLOUD_SYNC', 'Cloud sync flush failed; unsynced rows remain queued', {
        retryInMs: this.nextBackoffMs,
      }, err);
      this.scheduleRetry();
    } finally {
      this.flushing = false;
    }
  }

  status(): CloudSyncStatus {
    return {
      configured: this.isConfigured(),
      deviceId: this.deviceId,
      pending: {
        observations: this.countPending('observations'),
        summaries: this.countPending('session_summaries'),
        prompts: this.countPending('user_prompts'),
        mutations: this.countPendingMutations(),
      },
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }

  /**
   * Halt permanently: clears timers AND makes any in-flight flush bail before
   * its next DB touch, so a closing worker never SELECTs or stamps against a
   * closed database — and scheduleRetry() cannot re-arm a timer after stop.
   */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Drain internals
  // -------------------------------------------------------------------------

  /**
   * Drain the sync_outbox (migration v42). Acked ops are DELETEd — the
   * outbox is a queue, not data — so the page SELECT naturally advances.
   * set_prompt_session bodies store target.origin_device_id = NULL ("this
   * device"); the resolved id is substituted here, at push time, keeping
   * device identity single-sourced (SyncApply DEVICE IDENTITY note).
   */
  private async drainMutations(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const rows = this.db.prepare(
        `SELECT id, op_uuid, rev, body FROM sync_outbox ORDER BY id LIMIT ${BATCH}`
      ).all() as Array<{ id: number; op_uuid: string; rev: number; body: string }>;
      if (rows.length === 0) break;

      // Same size-bounded packing as drainKind: mutation bodies are usually
      // tiny, but a page of clamped 200KB titles must still never exceed the
      // request budget.
      let buf: WireOp[] = [];
      let bufBytes = 0;
      const send = async (): Promise<void> => {
        if (this.stopped || buf.length === 0) return;
        await this.sendOps(buf);
        buf = [];
        bufBytes = 0;
      };
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.body);
        } catch {
          parsed = null;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          // An unparseable envelope can never become valid, and the hub would
          // refuse the WHOLE batch for it (HTTP 400) — wedging the drain
          // forever. Drop it loudly instead.
          logger.error('CLOUD_SYNC', 'Dropping unparseable mutation op from sync_outbox', {
            opUuid: row.op_uuid,
          });
          this.db.prepare('DELETE FROM sync_outbox WHERE id = ?').run(row.id);
          continue;
        }
        let body = parsed as OpBody;
        if (body.op === 'set_prompt_session' && typeof body.target === 'object' && body.target !== null) {
          const target = body.target as Record<string, unknown>;
          if (target.origin_device_id == null) target.origin_device_id = this.deviceId;
        }
        // Size invariant for ALL kinds (see module header): clamp envelope
        // fields to 200KB, then hard re-clamp if the serialized op would
        // still exceed the hub's per-op backstop. Belt over the enqueue-side
        // clamp — it also covers ops queued by remap-outbox or older builds.
        body = clampMutationBody(body, MAX_FIELD_BYTES);
        let op: WireOp = { kind: 'mutation', origin_id: row.op_uuid, rev: row.rev, body };
        let size = JSON.stringify(op).length;
        if (size > MAX_OP_BYTES) {
          op = { ...op, body: clampMutationBody(body, HARD_FIELD_BYTES) };
          size = JSON.stringify(op).length;
        }
        if (buf.length > 0 && (bufBytes + size > MAX_BODY_BYTES || buf.length >= MAX_OPS_PER_PUSH)) {
          await send();
          if (this.stopped) return;
        }
        buf.push(op);
        bufBytes += size;
      }
      await send();
      if (this.stopped) return;
      // Loop re-SELECTs: acked ops were DELETEd (and a page of nothing but
      // dropped-unparseable rows made progress via those DELETEs).
    }
  }

  private async drainKind(kind: KindSpec): Promise<void> {
    // Loop until drained: every successful sub-batch stamps its rows, so the
    // next page naturally excludes them; a failed POST throws out of the loop.
    // `stopped` is re-checked after every await so a stop() during an
    // in-flight POST bails before the next DB touch (SELECT or stamp).
    for (;;) {
      if (this.stopped) return;
      const rows = this.db.prepare(kind.selectSql).all() as LocalRow[];
      if (rows.length === 0) break;

      // Pack ops into size-bounded requests so one page of fat rows can't
      // exceed the request-body cap.
      let buf: WireOp[] = [];
      let bufBytes = 0;
      const send = async (): Promise<void> => {
        if (this.stopped || buf.length === 0) return;
        await this.sendOps(buf);
        buf = [];
        bufBytes = 0;
      };
      for (const r of rows) {
        let body = clampFields(kind.toBody(r), MAX_FIELD_BYTES);
        let size = JSON.stringify(body).length;
        if (size > MAX_OP_BYTES) {
          body = clampFields(body, HARD_FIELD_BYTES);
          size = JSON.stringify(body).length;
        }
        if (buf.length > 0 && (bufBytes + size > MAX_BODY_BYTES || buf.length >= MAX_OPS_PER_PUSH)) {
          await send();
          if (this.stopped) return;
        }
        buf.push({ kind: kind.kind, origin_id: String(r.id), rev: Number(r.sync_rev) || 1, body });
        bufBytes += size;
      }
      await send();
      if (this.stopped) return;
    }
  }

  /** POST one batch to the hub and stamp/delete on ack. */
  private async sendOps(ops: WireOp[]): Promise<void> {
    const response = await this.pushOps(ops);
    // stop() while the POST was in flight: the DB may already be closing, so
    // skip the stamp. The hub dedupes on (origin_device, kind, origin_id,
    // rev), so re-pushing these ops on next start is harmless.
    if (this.stopped) return;
    this.stampAcked(response.acked);

    // LIVELOCK GUARD (see module header): the drain loops advance ONLY via
    // acks. A 200 whose acked array misses pushed ops (hub regression,
    // middlebox truncation that still parses) would re-SELECT and re-POST
    // the same rows at line rate forever — no error, no backoff, no
    // lastError. Treat any un-acked pushed op as a push failure: the acks
    // that DID arrive are already stamped above (partial progress kept), and
    // this throw rides the normal flush catch into backoff + lastError.
    const ackedKeys = new Set(
      response.acked.map(a => `${a.kind} ${a.origin_id} ${a.rev}`)
    );
    const unacked = ops.filter(
      op => !ackedKeys.has(`${op.kind} ${op.origin_id} ${op.rev}`)
    );
    if (unacked.length > 0) {
      throw new Error(
        `sync hub push: 200 response did not ack ${unacked.length} of ${ops.length} pushed ops — failing into backoff instead of retrying at line rate`
      );
    }

    this.emitHeadSeq(response.head_seq);
  }

  private async pushOps(ops: WireOp[]): Promise<PushResponse> {
    const res = await this.fetchImpl(`${this.hubUrl}/v1/sync/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'X-User-Id': this.userId,
        'X-Device-Id': this.deviceId,
        ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
      },
      body: JSON.stringify({ ops }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`sync hub push ${res.status}: ${body}`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('sync hub push: response is not JSON');
    }
    const acked = (parsed as { acked?: unknown } | null)?.acked;
    if (!Array.isArray(acked)) {
      throw new Error('sync hub push: response missing acked array');
    }
    const headSeq = (parsed as { head_seq?: unknown }).head_seq;
    return {
      acked: acked as AckedOp[],
      head_seq: typeof headSeq === 'number' ? headSeq : 0,
    };
  }

  /**
   * Stamp rows / delete outbox entries for acked ops. Acks are matched by
   * (kind, origin_id, rev); the hub may return them in any order.
   */
  private stampAcked(acked: AckedOp[]): void {
    const now = Date.now();
    for (const ack of acked) {
      if (ack.kind === 'mutation') {
        this.db.prepare('DELETE FROM sync_outbox WHERE op_uuid = ?').run(ack.origin_id);
        continue;
      }
      const table = TABLE_BY_KIND[ack.kind as RowKind];
      if (!table) continue; // unknown kind in an ack — ignore rather than guess
      const id = Number.parseInt(ack.origin_id, 10);
      if (!Number.isFinite(id)) continue;
      // Rev-matched stamp (replaces the old stampGuard): a row whose sync_rev
      // was bumped while this POST was in flight keeps synced_at NULL and the
      // drain loop re-pushes it at the new rev.
      this.db.prepare(
        `UPDATE ${table} SET synced_at = ? WHERE id = ? AND sync_rev = ? AND origin_device_id IS NULL`
      ).run(now, id, ack.rev);
    }
  }

  /** Never let a listener failure fail the flush. */
  private emitHeadSeq(headSeq: number): void {
    if (!this.headSeqListener) return;
    try {
      this.headSeqListener(headSeq);
    } catch (error) {
      logger.debug('CLOUD_SYNC', 'head_seq listener threw (ignored)', {},
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  private countPending(table: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NULL AND origin_device_id IS NULL`
    ).get() as { n: number };
    return row.n;
  }

  private countPendingMutations(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
      return row.n;
    } catch {
      return 0; // pre-v42 DB (possible only for out-of-band callers)
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.nextBackoffMs;
    this.nextBackoffMs = Math.min(this.nextBackoffMs * 2, this.backoffMaxMs);
    const timer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.retryTimer = timer;
  }

  private resetBackoff(): void {
    this.nextBackoffMs = this.backoffInitialMs;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Device identity
  // -------------------------------------------------------------------------

  /**
   * Resolve this install's stable device id, in priority order:
   *   1. CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID from settings (already resolved once);
   *   2. the legacy standalone client's cloud-sync-state.json deviceId;
   *   3. a freshly minted randomUUID().
   *
   * CRITICAL: never mint a new id while a legacy state file exists — the hub
   * keys ops on (origin_device, kind, origin_id, rev), so a new id forks
   * every previously pushed row into a duplicate entity. If the legacy file
   * is unreadable, fail closed (sync disabled) rather than guess.
   */
  private resolveDeviceId(configuredId: string): string {
    if (configuredId) return configuredId;

    if (existsSync(this.legacyStatePath)) {
      try {
        const parsed = parseJsonWithBom<{ deviceId?: unknown }>(readFileSync(this.legacyStatePath, 'utf-8'));
        const legacyId = parsed && typeof parsed === 'object' ? parsed.deviceId : undefined;
        if (typeof legacyId !== 'string' || legacyId === '') {
          throw new Error('legacy cloud-sync state has no valid deviceId');
        }
        try {
          this.persistDeviceId(legacyId);
        } catch (persistError) {
          // Adoption survives a failed persist: the legacy file still holds
          // the id, so the next start re-adopts the SAME id — no fork risk.
          logger.warn('CLOUD_SYNC', 'Adopted legacy device id but failed to persist it to settings; will re-adopt on next start', {
            settingsPath: this.settingsPath,
          }, persistError instanceof Error ? persistError : new Error(String(persistError)));
        }
        logger.info('CLOUD_SYNC', 'Adopted device id from legacy cloud-sync state', {
          deviceId: legacyId,
          statePath: this.legacyStatePath,
        });
        return legacyId;
      } catch (error) {
        this.lastError = 'legacy cloud-sync state unreadable — sync disabled to avoid forking device identity';
        logger.error('CLOUD_SYNC', 'Legacy cloud-sync state exists but is unusable; refusing to mint a new device id (fix or delete the file)', {
          statePath: this.legacyStatePath,
        }, error instanceof Error ? error : new Error(String(error)));
        return '';
      }
    }

    // First run on a fresh install: mint and persist immediately, so a later
    // transient failure can't mint a different one and fork device identity.
    const minted = randomUUID();
    try {
      this.persistDeviceId(minted);
    } catch (error) {
      this.lastError = 'failed to persist minted device id — sync disabled this session';
      logger.error('CLOUD_SYNC', 'Could not persist a freshly minted device id; disabling sync rather than uploading under an unstable identity', {
        settingsPath: this.settingsPath,
      }, error instanceof Error ? error : new Error(String(error)));
      return '';
    }
    logger.info('CLOUD_SYNC', 'Minted new cloud sync device id', { deviceId: minted });
    return minted;
  }

  // Same read-mutate-write pattern as SettingsRoutes.handleUpdateSettings.
  private persistDeviceId(deviceId: string): void {
    let settings: Record<string, unknown>;
    if (existsSync(this.settingsPath)) {
      settings = parseJsonWithBom<Record<string, unknown>>(readFileSync(this.settingsPath, 'utf-8'));
    } else {
      settings = { ...SettingsDefaultsManager.getAllDefaults() };
    }
    // Settings files are flat post-migration, but tolerate the legacy nested
    // {env:{...}} shape rather than writing a mixed schema.
    const target = settings.env && typeof settings.env === 'object'
      ? settings.env as Record<string, unknown>
      : settings;
    target.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID = deviceId;
    writeJsonFileAtomic(this.settingsPath, settings);
  }
}
