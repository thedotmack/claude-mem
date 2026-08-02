// Worker-native cloud sync push drain — the database is the queue.
//
// Every memory row carries a `synced_at` column (NULL = not in the hub's log;
// migration v36/v39). Write sites nudge `notify()` after each local write; a
// trailing debounce coalesces bursts into one `flush()`, which drains
// `WHERE synced_at IS NULL AND origin_device_id IS NULL` in batches, POSTs to
// the per-user sync hub (workers/sync-hub), and stamps rows on ack. That
// single mechanism handles post-launch live sync, offline catch-up, and retry
// — no historical/pre-launch backfill, second process, or cursor files.
// Mutation ops (custom title, prompt→session
// repair, project remaps) ride the same flush from the `sync_outbox` table
// (migration v42). Already-frozen content (especially tombstones) drains
// first; mutations drain before newly materialized row snapshots so title
// parking still precedes the related first row append.
//
// WIRE CONTRACT: POST {hubUrl}/v1/sync/ops with protocol_version 2 and
// `{body, operation_sha256}` wrappers. `body` is exact canonical JSON: sorted
// object keys, decimal strings for uint64 domains, stable content ids derived
// from (kind, device, local rowid), payload hash, entity revision, and explicit
// tombstone state. The Hub durably appends first, projects to Pro, and returns
// 200 only when its authoritative projection checkpoint covers the commit.
//
// STAMPING: before touching SQLite, the complete 200 response must prove an
// exact multiset match with the pushed (id, kind, rev, operation hash)
// tuples, valid sequence ownership, and a projection checkpoint covering
// every tuple. The hub may return acks in any order. A row is stamped ONLY where its
// CURRENT sync_rev still equals the acked rev, so a mutation site bumping
// sync_rev while a POST is in
// flight (e.g. requeuePromptSync registering a memory id) leaves the row
// unsynced and the same flush loop re-pushes it corrected at the higher rev.
// Acked mutation ops are DELETEd from sync_outbox (queue entries, not data).
//
// SIZE CONTRACT: each canonical body is at most 256,000 UTF-8 bytes and each
// request is packed below 4,000,000 bytes / 500 ops. Invalid queued rows
// are moved to a durable dead-letter with their exact rejection reason so a
// poison row cannot wedge later work. Mutation semantics are never clamped or
// rewritten: all bounded fields are validated in UTF-8 bytes before append.
//
// LIVELOCK GUARD: the drain loops make forward progress ONLY via acks
// (stamp/DELETE). Any malformed or incomplete 200 response is rejected
// before acknowledgment state changes and enters the normal backoff path.

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  assertCanonicalDecimal,
  buildContentOperation,
  buildMutationOperation,
  compareCanonicalDecimals,
  incrementCanonicalDecimal,
  parseCanonicalOperation,
  stableDocumentId,
  type CanonicalWireOp,
  type ContentKind,
} from './CanonicalContent.js';

// Page size for the drain SELECTs.
const BATCH = 200;
// Request-body packing budget — well under the hub's 8,000,000-byte cap.
const MAX_BODY_BYTES = 4_000_000;
// Hub cap: ≤500 ops per POST /v1/sync/ops request.
const MAX_OPS_PER_PUSH = 500;
const EMPTY_PUSH_REQUEST_BYTES = Buffer.byteLength(
  JSON.stringify({ protocol_version: 2, ops: [] }),
  'utf8',
);

/** Exact encoded request bytes from the sum of serialized op wrapper bytes. */
function pushRequestBytes(opBytes: number, opCount: number): number {
  return EMPTY_PUSH_REQUEST_BYTES + opBytes + Math.max(0, opCount - 1);
}
type LocalRow = Record<string, unknown> & { id: string; sync_rev: string };
type OpBody = Record<string, unknown>;

type RowKind = ContentKind;

type WireOp = CanonicalWireOp;

interface MutationOutboxRow {
  id: string;
  op_uuid: string;
  rev: string;
  body: string;
  canonical_body: string | null;
  operation_sha256: string | null;
}

interface AckedOp {
  id: string;
  kind: string;
  origin_local_id: string | null;
  entity_rev: string;
  operation_sha256: string;
  seq: string;
}

interface PushResponse {
  acked: AckedOp[];
  head_seq: string;
  projected_seq: string;
}

function operationTupleKey(tuple: {
  id: string;
  kind: string;
  entity_rev: string;
  operation_sha256: string;
}): string {
  // JSON avoids delimiter ambiguity if a future id/kind alphabet expands.
  return JSON.stringify([
    tuple.id,
    tuple.kind,
    tuple.entity_rev,
    tuple.operation_sha256,
  ]);
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
  /** Exact current-row read used by ack drift reconciliation. */
  selectOneSql: string;
  /** Op body per the SyncApply BODY FIELD MAPPING — values exactly as stored. */
  toBody: (r: LocalRow) => OpBody;
}

function decimalPayload(value: unknown, name: string, nullable = false): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    return '0';
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`cloud sync canonical payload: ${name} must be a non-negative safe integer`);
  }
  return String(value);
}

function jsonPayloadColumn(value: unknown, name: string, expected: 'array' | 'object'): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`cloud sync canonical payload: ${name} must be stored JSON text`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error(`cloud sync canonical payload: ${name} is not valid JSON`);
  }
  if (expected === 'array' && !Array.isArray(parsed)) {
    throw new Error(`cloud sync canonical payload: ${name} must decode to an array`);
  }
  if (expected === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    throw new Error(`cloud sync canonical payload: ${name} must decode to an object`);
  }
  return parsed;
}

const KINDS: KindSpec[] = [
  {
    kind: 'observation',
    localTable: 'observations',
    selectSql: `
      SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev,
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified, prompt_number,
        discovery_tokens, content_hash, generated_by_model, agent_type, agent_id,
        metadata, merged_into_project, created_at, created_at_epoch
      FROM observations
      WHERE synced_at IS NULL AND origin_device_id IS NULL
      ORDER BY id LIMIT ${BATCH}`,
    selectOneSql: `
      SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev,
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified, prompt_number,
        discovery_tokens, content_hash, generated_by_model, agent_type, agent_id,
        metadata, merged_into_project, created_at, created_at_epoch
      FROM observations
      WHERE id = ? AND origin_device_id IS NULL`,
    toBody: (r) => ({
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? 'unknown',
      text: r.text ?? null,
      type: r.type ?? null,
      title: r.title ?? null,
      subtitle: r.subtitle ?? null,
      facts: jsonPayloadColumn(r.facts, 'facts', 'array'),
      narrative: r.narrative ?? null,
      concepts: jsonPayloadColumn(r.concepts, 'concepts', 'array'),
      files_read: jsonPayloadColumn(r.files_read, 'files_read', 'array'),
      files_modified: jsonPayloadColumn(r.files_modified, 'files_modified', 'array'),
      prompt_number: decimalPayload(r.prompt_number, 'prompt_number', true),
      discovery_tokens: decimalPayload(r.discovery_tokens, 'discovery_tokens'),
      content_hash: r.content_hash ?? null,
      generated_by_model: r.generated_by_model ?? null,
      agent_type: r.agent_type ?? null,
      agent_id: r.agent_id ?? null,
      metadata: jsonPayloadColumn(r.metadata, 'metadata', 'object'),
      merged_into_project: r.merged_into_project ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: decimalPayload(r.created_at_epoch, 'created_at_epoch'),
    }),
  },
  {
    kind: 'summary',
    localTable: 'session_summaries',
    selectSql: `
      SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev,
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes, prompt_number,
        discovery_tokens, merged_into_project, created_at, created_at_epoch
      FROM session_summaries
      WHERE synced_at IS NULL AND origin_device_id IS NULL
      ORDER BY id LIMIT ${BATCH}`,
    selectOneSql: `
      SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev,
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes, prompt_number,
        discovery_tokens, merged_into_project, created_at, created_at_epoch
      FROM session_summaries
      WHERE id = ? AND origin_device_id IS NULL`,
    toBody: (r) => ({
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? 'unknown',
      request: r.request ?? null,
      investigated: r.investigated ?? null,
      learned: r.learned ?? null,
      completed: r.completed ?? null,
      next_steps: r.next_steps ?? null,
      files_read: jsonPayloadColumn(r.files_read, 'files_read', 'array'),
      files_edited: jsonPayloadColumn(r.files_edited, 'files_edited', 'array'),
      notes: r.notes ?? null,
      prompt_number: decimalPayload(r.prompt_number, 'prompt_number', true),
      discovery_tokens: decimalPayload(r.discovery_tokens, 'discovery_tokens'),
      merged_into_project: r.merged_into_project ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: decimalPayload(r.created_at_epoch, 'created_at_epoch'),
    }),
  },
  {
    kind: 'prompt',
    localTable: 'user_prompts',
    // memory_session_id/project/platform_source resolve through the same
    // sdk_sessions LEFT JOIN the local viewer uses (SyncApply BODY FIELD
    // MAPPING, kind 'prompt'); memory_session_id may be null — the apply side
    // links orphans later via set_prompt_session. Project uses the explicit
    // `unknown` sentinel because canonical v2 requires it. session_db_id NEVER travels (a
    // device-local rowid, re-resolved on apply).
    //
    // ACCEPTED LIMITATION (join-field drift): the body embeds JOINED session
    // fields, but the op's rev covers only the prompt row itself — a later
    // change to the owning session (e.g. a project remap) does not bump
    // prompt revs or re-push prompts, so replicas' embedded copies can lag.
    // Divergence is corrected by the mutation lane (remap_project /
    // set_prompt_session predicates), not the prompt row lane.
    selectSql: `
      SELECT CAST(up.id AS TEXT) AS id, CAST(up.sync_rev AS TEXT) AS sync_rev,
        up.content_session_id AS content_session_id,
        up.prompt_number AS prompt_number,
        up.prompt_text AS prompt_text,
        up.created_at AS created_at, up.created_at_epoch AS created_at_epoch,
        s.memory_session_id AS memory_session_id, s.project AS project,
        s.platform_source AS platform_source
      FROM user_prompts up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.synced_at IS NULL AND up.origin_device_id IS NULL
      ORDER BY up.id LIMIT ${BATCH}`,
    selectOneSql: `
      SELECT CAST(up.id AS TEXT) AS id, CAST(up.sync_rev AS TEXT) AS sync_rev,
        up.content_session_id AS content_session_id,
        up.prompt_number AS prompt_number,
        up.prompt_text AS prompt_text,
        up.created_at AS created_at, up.created_at_epoch AS created_at_epoch,
        s.memory_session_id AS memory_session_id, s.project AS project,
        s.platform_source AS platform_source
      FROM user_prompts up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ? AND up.origin_device_id IS NULL`,
    toBody: (r) => ({
      content_session_id: r.content_session_id ?? null,
      prompt_number: decimalPayload(r.prompt_number, 'prompt_number'),
      prompt_text: r.prompt_text ?? null,
      created_at: r.created_at ?? null,
      created_at_epoch: decimalPayload(r.created_at_epoch, 'created_at_epoch'),
      memory_session_id: r.memory_session_id ?? null,
      project: r.project ?? 'unknown',
      platform_source: r.platform_source ?? null,
    }),
  },
];

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
  pending: { observations: number; summaries: number; prompts: number; mutations: number; tombstones: number };
  quarantine: { count: number; latestReason: string | null };
  lastFlushAt: number | null;
  lastError: string | null;
  hub: {
    checkedAt: number | null;
    reachable: boolean | null;
    epoch: string | null;
    headSeq: string | null;
    projectedSeq: string | null;
    error: string | null;
  };
}

export class CloudSync {
  private readonly db: Database;
  private readonly token: string;
  private readonly userId: string;
  private readonly hubUrl: string;
  private readonly deviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly settingsPath: string;
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
  private hubStatus: CloudSyncStatus['hub'] = {
    checkedAt: null,
    reachable: null,
    epoch: null,
    headSeq: null,
    projectedSeq: null,
    error: null,
  };
  /** True while SyncClient's advisory socket is live (setFastDebounce). */
  private fastDebounce = false;
  /**
   * head_seq piggyback (plan Phase 3 task 3): every push response carries the
   * hub's head_seq; SyncClient registers here so a push that reveals unseen
   * remote ops triggers a pull without waiting for the poll timer.
   */
  private headSeqListener: ((headSeq: string) => void) | null = null;
  /**
   * X-Sync-Mode piggyback (plan Phase 5 task 2 — the kill switch): while the
   * hub's kill switch is tripped, EVERY HTTP sync response carries
   * `X-Sync-Mode: poll`. Pushes are CloudSync's fetches, so this listener
   * (wired to SyncClient.onSyncModeHint, same thin-callback shape as
   * head_seq) is how the push surface reports the mode — 'poll' drops the
   * advisory socket; the header disappearing restores it.
   */
  private syncModeListener: ((mode: string | null) => void) | null = null;

  constructor(db: Database, settings: CloudSyncSettingKeys, options: CloudSyncOptions = {}) {
    this.db = db;
    this.token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN ?? '';
    this.userId = settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID ?? '';
    // Launch contract: the Hub URL has no default. Empty means sync is off;
    // there is no application-API or per-kind fallback lane.
    this.hubUrl = (settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '').trim().replace(/\/+$/, '');
    // Human-readable device label for the dashboard's Devices panel.
    this.deviceName = (settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME || hostname() || '').slice(0, 80);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
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
  setHeadSeqListener(listener: ((headSeq: string) => void) | null): void {
    this.headSeqListener = listener;
  }

  /**
   * SyncClient wiring (plan Phase 5 task 2): called with the raw
   * `X-Sync-Mode` header value. A present header is reported from ANY
   * response status; null ("cleared") is reported only from OK responses —
   * header absence on an error response is ambiguous and suppressed at
   * this source (SyncClient.onSyncModeHint contract). Never called on
   * network failure (no response, no signal).
   */
  setSyncModeListener(listener: ((mode: string | null) => void) | null): void {
    this.syncModeListener = listener;
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
   * Kick one non-blocking catch-up flush for eligible post-launch writes.
   * The v47 launch baseline is deliberately stamped/excluded and is not a
   * historical corpus to upload.
   */
  start(): void {
    if (!this.isActive()) {
      logger.debug('CLOUD_SYNC', 'Cloud sync inactive; start() skipped', {
        configured: this.isConfigured(),
        tokenLength: this.token.length, // never the token itself
      });
      return;
    }
    logger.info('CLOUD_SYNC', 'Cloud sync active — kicking post-launch catch-up drain', {
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
   * Drain everything unsynced. Frozen content snapshots go first so a queued
   * tombstone supersedes older work promptly; mutations then precede newly
   * materialized row snapshots (set_title parking depends on that ordering).
   * Single-flight: a flush arriving while one is running marks a re-run
   * instead of overlapping, so rows written mid-flush are still picked up.
   * Never rejects.
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
        await this.drainContentOutbox();
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
        tombstones: this.countPendingTombstones(),
      },
      quarantine: this.quarantineStatus(),
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      hub: { ...this.hubStatus },
    };
  }

  /**
   * Status for the local `/api/sync/status` route. Even with an empty queue,
   * authenticate directly against SyncHub so "nothing to upload" cannot be
   * mistaken for a working connection. This is a read-only Hub status GET:
   * it never appends an operation or advances a client cursor.
   */
  async statusWithHubProbe(): Promise<CloudSyncStatus> {
    if (!this.stopped && this.isActive()) {
      await this.probeHubStatus();
    }
    return this.status();
  }

  private async probeHubStatus(): Promise<void> {
    let checkedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.hubUrl}/v1/sync/status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-User-Id': this.userId,
          'X-Device-Id': this.deviceId,
          ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      checkedAt = Date.now();
      const syncMode = response.headers.get('X-Sync-Mode');
      if (syncMode !== null || response.ok) this.emitSyncMode(syncMode);
      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`sync hub status ${response.status}: ${body}`);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new Error('sync hub status: response is not JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('sync hub status: response must be an object');
      }
      const record = parsed as Record<string, unknown>;
      if (record.protocol_version !== 2) {
        throw new Error('sync hub status: response requires protocol_version 2');
      }
      if (
        typeof record.epoch !== 'string'
        || typeof record.head_seq !== 'string'
        || typeof record.projected_seq !== 'string'
      ) {
        throw new Error('sync hub status: response requires decimal-string epoch/head_seq/projected_seq');
      }
      const epoch = assertCanonicalDecimal(record.epoch, { positive: true });
      const headSeq = assertCanonicalDecimal(record.head_seq);
      const projectedSeq = assertCanonicalDecimal(record.projected_seq);
      if (compareCanonicalDecimals(projectedSeq, headSeq) > 0) {
        throw new Error('sync hub status: projected_seq exceeds head_seq');
      }
      this.hubStatus = {
        checkedAt,
        reachable: true,
        epoch,
        headSeq,
        projectedSeq,
        error: null,
      };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const safe = this.token === '' ? raw : raw.split(this.token).join('[REDACTED]');
      this.hubStatus = {
        checkedAt,
        reachable: false,
        epoch: null,
        headSeq: null,
        projectedSeq: null,
        error: safe,
      };
    }
  }

  /**
   * Queue and apply a local content deletion atomically. The tombstone stays
   * durable in sync_content_outbox until Hub projection acknowledges it.
   */
  queueDelete(kind: RowKind, originLocalId: string, deletedAt = new Date().toISOString()): string {
    if (!this.isActive()) throw new Error('cloud sync must be configured before queueDelete');
    assertCanonicalDecimal(originLocalId);
    const entityId = stableDocumentId(kind, this.deviceId, originLocalId);
    const table = TABLE_BY_KIND[kind];
    let entityRev = '0';
    const tx = this.db.transaction(() => {
      const revisions: string[] = [];
      const local = this.db.prepare(
        `SELECT CAST(sync_rev AS TEXT) AS entity_rev
         FROM ${table} WHERE id = ? AND origin_device_id IS NULL`
      ).get(originLocalId) as { entity_rev: string } | undefined;
      if (local) revisions.push(local.entity_rev);
      const head = this.db.prepare(
        'SELECT entity_rev FROM sync_entity_heads WHERE entity_id = ?'
      ).get(entityId) as { entity_rev: string } | undefined;
      if (head) revisions.push(head.entity_rev);
      const pending = this.db.prepare(
        'SELECT entity_rev FROM sync_content_outbox WHERE entity_id = ?'
      ).all(entityId) as Array<{ entity_rev: string }>;
      revisions.push(...pending.map(row => row.entity_rev));
      entityRev = incrementCanonicalDecimal(this.maxDecimal(revisions));

      const op = buildContentOperation({
        kind,
        originDeviceId: this.deviceId,
        originLocalId,
        entityRev,
        payload: null,
        deleted: true,
        deletedAt,
      });
      // A delete supersedes any not-yet-sent/sent-but-unacked live snapshot.
      // The immutable bytes may already exist at the Hub; the higher-rev
      // tombstone is the only safe way to supersede them there.
      this.db.prepare(
        'DELETE FROM sync_content_outbox WHERE entity_id = ? AND deleted = 0'
      ).run(entityId);
      this.db.prepare(`
        INSERT INTO sync_content_outbox
          (entity_id, kind, origin_local_id, entity_rev, body, operation_sha256, deleted, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(entity_id, entity_rev) DO NOTHING
      `).run(entityId, kind, originLocalId, entityRev, op.body, op.operation_sha256, Date.now());
      this.db.prepare(
        `DELETE FROM ${table} WHERE id = ? AND origin_device_id IS NULL`
      ).run(originLocalId);
    });
    tx();
    this.notify();
    return entityRev;
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

  /** Drain immutable live/delete/revive snapshots exactly as persisted. */
  private async drainContentOutbox(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const rows = this.db.prepare(`
        SELECT body, operation_sha256 FROM sync_content_outbox
        ORDER BY deleted DESC, id LIMIT ${BATCH}
      `).all() as Array<CanonicalWireOp>;
      if (rows.length === 0) return;
      let batch: WireOp[] = [];
      let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
        if (batch.length > 0 && (
          batch.length >= MAX_OPS_PER_PUSH
          || pushRequestBytes(bytes + size, batch.length + 1) > MAX_BODY_BYTES
        )) {
          await this.sendOps(batch);
          if (this.stopped) return;
          batch = [];
          bytes = 0;
        }
        batch.push(row);
        bytes += size;
      }
      if (batch.length > 0) await this.sendOps(batch);
    }
  }

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
        `SELECT CAST(id AS TEXT) AS id, op_uuid, CAST(rev AS TEXT) AS rev,
                body, canonical_body, operation_sha256
         FROM sync_outbox ORDER BY id LIMIT ${BATCH}`
      ).all() as MutationOutboxRow[];
      if (rows.length === 0) break;

      // Same size-bounded packing as drainKind: mutation bodies are usually
      // tiny, but every page still stays within the request budget.
      let buf: WireOp[] = [];
      let bufBytes = 0;
      const send = async (): Promise<void> => {
        if (this.stopped || buf.length === 0) return;
        await this.sendOps(buf);
        buf = [];
        bufBytes = 0;
      };
      for (const row of rows) {
        try {
          let op: WireOp;
          if (row.canonical_body !== null || row.operation_sha256 !== null) {
            if (row.canonical_body === null || row.operation_sha256 === null) {
              throw new Error('partial canonical mutation snapshot');
            }
            op = { body: row.canonical_body, operation_sha256: row.operation_sha256 };
            parseCanonicalOperation(op);
          } else {
            let parsed: unknown;
            try {
              parsed = JSON.parse(row.body);
            } catch {
              throw new Error('mutation body is not JSON');
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('mutation body must be an object');
            }
            const body = parsed as OpBody;
            if (body.op === 'set_prompt_session' && typeof body.target === 'object' && body.target !== null) {
              const target = body.target as Record<string, unknown>;
              if (target.origin_device_id == null) target.origin_device_id = this.deviceId;
            }
            op = buildMutationOperation({
              originDeviceId: this.deviceId,
              mutationId: row.op_uuid,
              entityRev: row.rev,
              mutation: body as unknown as Parameters<typeof buildMutationOperation>[0]['mutation'],
            });
            // First accepted serialization is frozen before its first send.
            this.db.prepare(`
              UPDATE sync_outbox
              SET canonical_body = ?, operation_sha256 = ?
              WHERE id = ? AND canonical_body IS NULL AND operation_sha256 IS NULL
            `).run(op.body, op.operation_sha256, row.id);
          }
          const size = Buffer.byteLength(JSON.stringify(op), 'utf8');
          if (buf.length > 0 && (
            pushRequestBytes(bufBytes + size, buf.length + 1) > MAX_BODY_BYTES
            || buf.length >= MAX_OPS_PER_PUSH
          )) {
            await send();
            if (this.stopped) return;
          }
          buf.push(op);
          bufBytes += size;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.quarantineMutation(row, reason);
        }
      }
      await send();
      if (this.stopped) return;
      // Loop re-SELECTs: acked ops were DELETEd (and a page of nothing but
      // dropped-unparseable rows made progress via those DELETEs).
    }
  }

  private async drainKind(kind: KindSpec): Promise<void> {
    // Materialize each mutable SQLite row into an immutable canonical outbox
    // snapshot, then send only those stored bytes. Later local writes cannot
    // change a retry's body/hash; ack reconciliation queues a higher revision.
    for (;;) {
      if (this.stopped) return;
      const rows = this.db.prepare(kind.selectSql).all() as LocalRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        this.snapshotContentRow(kind, r);
      }
      await this.drainContentOutbox();
      if (this.stopped) return;
    }
  }

  private snapshotContentRow(kind: KindSpec, row: LocalRow): void {
    let entityId = `${kind.kind}:invalid:${row.id}`;
    try {
      const originLocalId = assertCanonicalDecimal(row.id);
      const localRev = assertCanonicalDecimal(row.sync_rev, { positive: true });
      entityId = stableDocumentId(kind.kind, this.deviceId, originLocalId);
      const head = this.db.prepare(
        'SELECT entity_rev, operation_sha256 FROM sync_entity_heads WHERE entity_id = ?'
      ).get(entityId) as { entity_rev: string; operation_sha256: string } | undefined;
      const pending = this.db.prepare(`
        SELECT entity_rev, operation_sha256
        FROM sync_content_outbox WHERE entity_id = ?
      `).all(entityId) as Array<{ entity_rev: string; operation_sha256: string }>;
      const maxRev = this.maxDecimal([
        localRev,
        ...(head ? [head.entity_rev] : []),
        ...pending.map(item => item.entity_rev),
      ]);

      let entityRev = localRev;
      let op = buildContentOperation({
        kind: kind.kind,
        originDeviceId: this.deviceId,
        originLocalId,
        entityRev,
        payload: kind.toBody(row),
      });
      const pendingSameRev = pending.find(item => item.entity_rev === entityRev);
      const headSameRev = head?.entity_rev === entityRev ? head : undefined;
      if (
        compareCanonicalDecimals(entityRev, maxRev) < 0
        || (pendingSameRev && pendingSameRev.operation_sha256 !== op.operation_sha256)
        || (headSameRev && headSameRev.operation_sha256 !== op.operation_sha256)
      ) {
        entityRev = incrementCanonicalDecimal(maxRev);
        op = buildContentOperation({
          kind: kind.kind,
          originDeviceId: this.deviceId,
          originLocalId,
          entityRev,
          payload: kind.toBody(row),
        });
      } else if (pendingSameRev?.operation_sha256 === op.operation_sha256) {
        return; // the exact immutable retry snapshot already exists
      }

      const tx = this.db.transaction(() => {
        if (entityRev !== localRev) {
          this.db.prepare(`
            UPDATE ${kind.localTable} SET sync_rev = ?, synced_at = NULL
            WHERE id = ? AND origin_device_id IS NULL
          `).run(entityRev, originLocalId);
        }
        this.db.prepare(`
          INSERT INTO sync_content_outbox
            (entity_id, kind, origin_local_id, entity_rev, body,
             operation_sha256, deleted, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(entity_id, entity_rev) DO NOTHING
        `).run(
          entityId, kind.kind, originLocalId, entityRev,
          op.body, op.operation_sha256, Date.now(),
        );
      });
      tx();
    } catch (error) {
      this.quarantineContent(kind, row, entityId, error);
    }
  }

  /** POST one batch to the hub and stamp/delete on ack. */
  private async sendOps(ops: WireOp[]): Promise<void> {
    const response = await this.pushOps(ops);
    // stop() while the POST was in flight: the DB may already be closing, so
    // skip the stamp. The hub dedupes on (origin_device, kind, origin_id,
    // rev), so re-pushing these ops on next start is harmless.
    if (this.stopped) return;
    this.validatePushResponse(response, ops);
    this.stampAcked(response.acked, ops);
    this.emitHeadSeq(response.head_seq);
  }

  private async pushOps(ops: WireOp[]): Promise<PushResponse> {
    const requestBody = JSON.stringify({ protocol_version: 2, ops });
    if (Buffer.byteLength(requestBody, 'utf8') > MAX_BODY_BYTES) {
      throw new Error(`sync hub push invariant: request exceeds ${MAX_BODY_BYTES} encoded bytes`);
    }
    const res = await this.fetchImpl(`${this.hubUrl}/v1/sync/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'X-User-Id': this.userId,
        'X-Device-Id': this.deviceId,
        ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
      },
      body: requestBody,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    // Mode hint BEFORE the ok-check: the kill-switch header rides error
    // responses too, and a client that only learned the mode from happy
    // paths would keep hammering the socket through an incident.
    // Asymmetric on purpose (SyncClient.onSyncModeHint contract): header
    // PRESENCE is emitted regardless of status; header ABSENCE is only
    // emitted (as null = "cleared") from an OK response — absence on an
    // error response is ambiguous (a degraded auth upstream 503s without
    // the funnel) and must not read as "switch cleared".
    const syncMode = res.headers.get('X-Sync-Mode');
    if (syncMode !== null || res.ok) {
      this.emitSyncMode(syncMode);
    }
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
    const projectedSeq = (parsed as { projected_seq?: unknown }).projected_seq;
    if (typeof headSeq !== 'string' || typeof projectedSeq !== 'string') {
      throw new Error('sync hub push: response requires decimal-string head_seq/projected_seq');
    }
    assertCanonicalDecimal(headSeq);
    assertCanonicalDecimal(projectedSeq);
    const validatedAcked = acked.map((value, index): AckedOp => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`sync hub push: acked[${index}] must be an object`);
      }
      const item = value as Record<string, unknown>;
      if (
        typeof item.id !== 'string'
        || typeof item.kind !== 'string'
        || (item.origin_local_id !== null && typeof item.origin_local_id !== 'string')
        || typeof item.entity_rev !== 'string'
        || typeof item.operation_sha256 !== 'string'
        || typeof item.seq !== 'string'
      ) {
        throw new Error(`sync hub push: malformed acked[${index}]`);
      }
      assertCanonicalDecimal(item.entity_rev, { positive: true });
      assertCanonicalDecimal(item.seq, { positive: true });
      if (typeof item.origin_local_id === 'string') assertCanonicalDecimal(item.origin_local_id);
      return item as unknown as AckedOp;
    });
    return {
      acked: validatedAcked,
      head_seq: headSeq,
      projected_seq: projectedSeq,
    };
  }

  /**
   * Treat a successful push response as one atomic acknowledgment proof.
   * Nothing in this method mutates SQLite. stampAcked() runs only after every
   * tuple, multiplicity, sequence, and checkpoint invariant has passed.
   */
  private validatePushResponse(response: PushResponse, pushed: WireOp[]): void {
    const sentCounts = new Map<string, number>();
    for (const op of pushed) {
      const body = parseCanonicalOperation(op);
      const key = operationTupleKey({
        id: body.id,
        kind: body.kind,
        entity_rev: body.entity_rev,
        operation_sha256: op.operation_sha256,
      });
      sentCounts.set(key, (sentCounts.get(key) ?? 0) + 1);
    }

    const ackCounts = new Map<string, number>();
    const tupleSeq = new Map<string, string>();
    const seqTuple = new Map<string, string>();
    for (const ack of response.acked) {
      const key = operationTupleKey(ack);
      if (!sentCounts.has(key)) {
        throw new Error('sync hub push: 200 response contains an extra or mismatched acknowledgment tuple');
      }
      ackCounts.set(key, (ackCounts.get(key) ?? 0) + 1);

      const priorTupleSeq = tupleSeq.get(key);
      if (priorTupleSeq !== undefined && priorTupleSeq !== ack.seq) {
        throw new Error('sync hub push: duplicate operation tuple claimed different sequences');
      }
      tupleSeq.set(key, ack.seq);

      const priorSeqTuple = seqTuple.get(ack.seq);
      if (priorSeqTuple !== undefined && priorSeqTuple !== key) {
        throw new Error('sync hub push: distinct operation tuples claimed the same sequence');
      }
      seqTuple.set(ack.seq, key);
    }

    for (const [key, expected] of sentCounts) {
      const actual = ackCounts.get(key) ?? 0;
      if (actual !== expected) {
        throw new Error(
          `sync hub push: 200 response acknowledgment multiplicity mismatch (expected ${expected}, received ${actual})`
        );
      }
    }
    if (ackCounts.size !== sentCounts.size) {
      // Defensive: the unknown-tuple branch above should make this impossible.
      throw new Error('sync hub push: 200 response acknowledgment multiset mismatch');
    }

    if (compareCanonicalDecimals(response.head_seq, response.projected_seq) > 0) {
      throw new Error('sync hub push: checkpoint order requires head_seq <= projected_seq');
    }
    for (const ack of response.acked) {
      if (compareCanonicalDecimals(ack.seq, response.head_seq) > 0) {
        throw new Error('sync hub push: acknowledgment seq exceeds head_seq');
      }
      if (compareCanonicalDecimals(ack.seq, response.projected_seq) > 0) {
        throw new Error('sync hub push: sent operation is not covered by projected_seq');
      }
    }
  }

  /**
   * Stamp rows / delete outbox entries for a fully validated acknowledgment
   * multiset. The hub may return entries in any order.
   */
  private stampAcked(acked: AckedOp[], pushed: WireOp[]): void {
    const now = Date.now();
    const bodies = new Map(pushed.map(op => {
      const body = parseCanonicalOperation(op);
      return [operationTupleKey({
        id: body.id,
        kind: body.kind,
        entity_rev: body.entity_rev,
        operation_sha256: op.operation_sha256,
      }), { body, operationSha256: op.operation_sha256 }] as const;
    }));
    const tx = this.db.transaction(() => {
      for (const ack of acked) {
        const pushedOp = bodies.get(operationTupleKey(ack));
        // validatePushResponse proved this lookup before the transaction.
        if (!pushedOp) throw new Error('sync hub push: validated acknowledgment tuple disappeared');
        if (ack.kind === 'mutation') {
          const mutationId = ack.id.startsWith('mutation:') ? ack.id.slice('mutation:'.length) : '';
          if (mutationId) {
            this.db.prepare(`
              DELETE FROM sync_outbox
              WHERE op_uuid = ? AND operation_sha256 = ?
            `).run(mutationId, pushedOp.operationSha256);
          }
          continue;
        }
        const body = pushedOp.body;
        if (body.origin_local_id === null) continue;
        this.advanceEntityHead(body, pushedOp.operationSha256, now);
        this.db.prepare(`
          DELETE FROM sync_content_outbox
          WHERE entity_id = ? AND entity_rev = ? AND operation_sha256 = ?
        `).run(body.id, body.entity_rev, pushedOp.operationSha256);
        this.reconcileAckedContent(body, pushedOp.operationSha256, now);
      }
    });
    tx();
  }

  private advanceEntityHead(
    body: ReturnType<typeof parseCanonicalOperation>,
    operationSha256: string,
    now: number,
  ): void {
    const current = this.db.prepare(`
      SELECT entity_rev, operation_sha256 FROM sync_entity_heads WHERE entity_id = ?
    `).get(body.id) as { entity_rev: string; operation_sha256: string } | undefined;
    if (current) {
      const order = compareCanonicalDecimals(body.entity_rev, current.entity_rev);
      if (order < 0) return;
      if (order === 0 && current.operation_sha256 !== operationSha256) {
        throw new Error(`cloud sync ack conflict for ${body.id} rev ${body.entity_rev}`);
      }
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
      body.id, body.kind, body.origin_device_id, body.origin_local_id,
      body.entity_rev, operationSha256, body.deleted ? 1 : 0, now,
    );
  }

  /**
   * Acking immutable bytes must not stamp away a write that happened while
   * the request was in flight. Compare the current row's complete canonical
   * operation, including prompt JOIN fields, and mint a higher follow-up on
   * any revision or payload drift.
   */
  private reconcileAckedContent(
    body: ReturnType<typeof parseCanonicalOperation>,
    operationSha256: string,
    now: number,
  ): void {
    if (body.kind === 'mutation' || body.origin_local_id === null) return;
    const spec = KINDS.find(item => item.kind === body.kind);
    if (!spec) return;
    const current = this.db.prepare(spec.selectOneSql).get(body.origin_local_id) as LocalRow | undefined;

    if (!current) {
      if (!body.deleted) this.ensureMissingRowTombstone(spec, body, now);
      return;
    }

    let currentRev: string;
    let currentAtAckRev: WireOp;
    try {
      currentRev = assertCanonicalDecimal(current.sync_rev, { positive: true });
      currentAtAckRev = buildContentOperation({
        kind: spec.kind,
        originDeviceId: this.deviceId,
        originLocalId: body.origin_local_id,
        entityRev: body.entity_rev,
        payload: spec.toBody(current),
      });
    } catch (error) {
      // stampAcked already owns the transaction here. Persist quarantine in
      // that same transaction so bad local drift cannot roll back the valid
      // frozen snapshot's head advance and outbox acknowledgement.
      const reason = this.writeContentQuarantine(spec, current, body.id, error);
      this.logContentQuarantine(spec, current, reason);
      return;
    }
    if (
      !body.deleted
      && currentRev === body.entity_rev
      && currentAtAckRev.operation_sha256 === operationSha256
    ) {
      this.db.prepare(`
        UPDATE ${spec.localTable} SET synced_at = ?
        WHERE id = ? AND origin_device_id IS NULL AND CAST(sync_rev AS TEXT) = ?
      `).run(now, body.origin_local_id, body.entity_rev);
      return;
    }

    const pending = this.db.prepare(
      'SELECT entity_rev FROM sync_content_outbox WHERE entity_id = ?'
    ).all(body.id) as Array<{ entity_rev: string }>;
    const maxRev = this.maxDecimal([
      currentRev,
      body.entity_rev,
      ...pending.map(item => item.entity_rev),
    ]);
    const currentAlreadyHigher = compareCanonicalDecimals(currentRev, body.entity_rev) > 0
      && pending.every(item => compareCanonicalDecimals(currentRev, item.entity_rev) > 0);
    const nextRev = currentAlreadyHigher ? currentRev : incrementCanonicalDecimal(maxRev);
    this.db.prepare(`
      UPDATE ${spec.localTable} SET sync_rev = ?, synced_at = NULL
      WHERE id = ? AND origin_device_id IS NULL
    `).run(nextRev, body.origin_local_id);
  }

  /** Defensive tombstone for an out-of-band DELETE that bypassed DataRoutes. */
  private ensureMissingRowTombstone(
    spec: KindSpec,
    body: ReturnType<typeof parseCanonicalOperation>,
    now: number,
  ): void {
    const pending = this.db.prepare(
      'SELECT entity_rev, deleted FROM sync_content_outbox WHERE entity_id = ?'
    ).all(body.id) as Array<{ entity_rev: string; deleted: number }>;
    if (pending.some(item => item.deleted === 1 && compareCanonicalDecimals(item.entity_rev, body.entity_rev) > 0)) {
      return;
    }
    const entityRev = incrementCanonicalDecimal(this.maxDecimal([
      body.entity_rev,
      ...pending.map(item => item.entity_rev),
    ]));
    const tombstone = buildContentOperation({
      kind: spec.kind,
      originDeviceId: this.deviceId,
      originLocalId: body.origin_local_id!,
      entityRev,
      payload: null,
      deleted: true,
      deletedAt: new Date(now).toISOString(),
    });
    this.db.prepare(`
      INSERT INTO sync_content_outbox
        (entity_id, kind, origin_local_id, entity_rev, body,
         operation_sha256, deleted, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(entity_id, entity_rev) DO NOTHING
    `).run(
      body.id, spec.kind, body.origin_local_id, entityRev,
      tombstone.body, tombstone.operation_sha256, now,
    );
  }

  /** Never let a listener failure fail the flush. */
  private emitHeadSeq(headSeq: string): void {
    if (!this.headSeqListener) return;
    try {
      this.headSeqListener(assertCanonicalDecimal(headSeq));
    } catch (error) {
      logger.debug('CLOUD_SYNC', 'head_seq listener threw (ignored)', {},
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Never let a listener failure fail the push. */
  private emitSyncMode(mode: string | null): void {
    if (!this.syncModeListener) return;
    try {
      this.syncModeListener(mode);
    } catch (error) {
      logger.debug('CLOUD_SYNC', 'sync-mode listener threw (ignored)', {},
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

  private countPendingTombstones(): number {
    try {
      return (this.db.prepare(
        'SELECT COUNT(*) AS n FROM sync_content_outbox WHERE deleted = 1'
      ).get() as { n: number }).n;
    } catch {
      return 0;
    }
  }

  private quarantineStatus(): { count: number; latestReason: string | null } {
    try {
      const count = (this.db.prepare(
        'SELECT COUNT(*) AS n FROM sync_dead_letter'
      ).get() as { n: number }).n;
      const latest = this.db.prepare(
        'SELECT reason FROM sync_dead_letter ORDER BY id DESC LIMIT 1'
      ).get() as { reason: string } | undefined;
      return { count, latestReason: latest?.reason ?? null };
    } catch {
      return { count: 0, latestReason: null };
    }
  }

  private maxDecimal(values: string[]): string {
    let max = '0';
    for (const value of values) {
      const canonical = assertCanonicalDecimal(value);
      if (compareCanonicalDecimals(canonical, max) > 0) max = canonical;
    }
    return max;
  }

  private quarantineContent(kind: KindSpec, row: LocalRow, entityId: string, error: unknown): void {
    let reason = '';
    const tx = this.db.transaction(() => {
      reason = this.writeContentQuarantine(kind, row, entityId, error);
    });
    tx();
    this.logContentQuarantine(kind, row, reason);
  }

  /** Write quarantine state without opening a transaction (ack reconciliation already owns one). */
  private writeContentQuarantine(
    kind: KindSpec,
    row: LocalRow,
    entityId: string,
    error: unknown,
  ): string {
    const reason = error instanceof Error ? error.message : String(error);
    let rawBody: string | null = null;
    try { rawBody = JSON.stringify(kind.toBody(row)); } catch { /* row remains the durable source */ }
    this.db.prepare(`
      INSERT INTO sync_dead_letter
        (lane, queue_key, kind, origin_local_id, entity_rev, reason, raw_body, created_at_epoch)
      VALUES ('content', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane, queue_key, entity_rev, reason) DO NOTHING
    `).run(entityId, kind.kind, row.id, row.sync_rev, reason, rawBody, Date.now());
    // -1 is a visible quarantine sentinel, not a successful sync stamp.
    // A later legitimate write re-nulls synced_at and is retried.
    this.db.prepare(`
      UPDATE ${kind.localTable} SET synced_at = -1
      WHERE id = ? AND origin_device_id IS NULL AND CAST(sync_rev AS TEXT) = ?
    `).run(row.id, row.sync_rev);
    return reason;
  }

  private logContentQuarantine(kind: KindSpec, row: LocalRow, reason: string): void {
    logger.error('CLOUD_SYNC', 'Quarantined invalid content row; later rows will continue', {
      kind: kind.kind,
      originLocalId: row.id,
      entityRev: row.sync_rev,
      reason,
    });
  }

  private quarantineMutation(row: MutationOutboxRow, reason: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_dead_letter
          (lane, queue_key, kind, origin_local_id, entity_rev, reason, raw_body, created_at_epoch)
        VALUES ('mutation', ?, 'mutation', NULL, ?, ?, ?, ?)
        ON CONFLICT(lane, queue_key, entity_rev, reason) DO NOTHING
      `).run(row.op_uuid, row.rev, reason, row.canonical_body ?? row.body, Date.now());
      this.db.prepare('DELETE FROM sync_outbox WHERE id = ?').run(row.id);
    });
    tx();
    logger.error('CLOUD_SYNC', 'Quarantined invalid mutation; later rows will continue', {
      opUuid: row.op_uuid,
      entityRev: row.rev,
      reason,
    });
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
   * Resolve this launch client's stable device id from settings, or mint and
   * immediately persist one. There is no standalone-client state to adopt.
   */
  private resolveDeviceId(configuredId: string): string {
    if (configuredId) return configuredId;

    // First run: mint and persist immediately, so a later
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
