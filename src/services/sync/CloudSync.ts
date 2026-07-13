// Worker-native cloud sync (cmem.ai Pro) — the database is the queue.
//
// Every memory row carries a `synced_at` column (NULL = not in the cloud;
// migration v36). Write sites nudge `notify()` after each local write; a
// trailing debounce coalesces bursts into one `flush()`, which drains
// `WHERE synced_at IS NULL` in batches, POSTs to cmem.ai, and stamps rows on
// success. That single mechanism IS live sync, backfill, offline catch-up,
// and retry — no second process, no cursor files.
//
// WIRE CONTRACT (fixed — the cmem.ai server is already deployed): the
// `toCloud` mappers, the prompts SQL-side clamp, and the body-size batching
// below are ported verbatim in behavior from the vetted standalone client at
// ~/.claude-mem/cloud-sync.mjs (source-reviewed 2026-07-08). Do not redesign
// field names, clamps, or batch semantics. Line references in comments cite
// that file.

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';

// Page size for the drain SELECT (cloud-sync.mjs:45).
const BATCH = 200;
// Real-world user_prompts tables carry multi-GB text (observed: single 7.4MB
// prompts from pasted logs), so upload bodies must be size-bounded (Vercel
// rejects bodies over ~4.5MB) and pathological single fields get clamped with
// a marker (cloud-sync.mjs:263-271).
const MAX_BODY_BYTES = 2_000_000;   // cloud-sync.mjs:269
const MAX_FIELD_BYTES = 200_000;    // cloud-sync.mjs:270
export const TRUNC_MARK = '\n…[truncated by cloud-sync: field exceeded 200KB]'; // cloud-sync.mjs:271

// Local stores facts/concepts/file lists as JSON strings; the cloud
// re-stringifies, so send the PARSED value to avoid double-encoding
// (cloud-sync.mjs:120-125).
const parseJson = (v: unknown): unknown => {
  if (v == null) return null;
  try { return JSON.parse(String(v)); } catch { return v; }
};

type LocalRow = Record<string, unknown> & { id: number };
type CloudRow = Record<string, unknown>;

interface KindSpec {
  name: 'observations' | 'summaries' | 'prompts';
  localTable: string;
  endpoint: string;
  bodyKey: string;
  selectCols: string;
  /** FROM clause override when the select needs a JOIN (default: localTable). */
  fromSql?: string;
  /** Alias qualifying synced_at/id in WHERE/ORDER BY when fromSql joins. */
  rowAlias?: string;
  /**
   * Stamp-time guard for kinds whose pushed shape depends on a JOIN: a
   * predicate on localTable (one `?` bound per row via stampGuard) that must
   * still hold when the POST returns. A row whose mapping changed while the
   * POST was in flight is NOT stamped — it stays unsynced and the next flush
   * re-pushes it with the current mapping (the server upserts on
   * (user_id, device_id, local_id), so the corrected row overwrites in place).
   * Without this, a memory id registered mid-POST is lost: the requeue hook
   * no-ops (synced_at is still NULL) and the stamp then marks the stale
   * fallback upload as synced.
   */
  stampGuardSql?: string;
  /** Captures the per-row guard value as it was SELECTed (bound to the `?`). */
  stampGuard?: (r: LocalRow) => string | null;
  toCloud: (r: LocalRow) => CloudRow;
}

// The three synced kinds; endpoints, body keys, and mappers ported from
// cloud-sync.mjs:132-262 (push lane only — pull is Phase 5).
const KINDS: KindSpec[] = [
  {
    name: 'observations',
    localTable: 'observations',
    endpoint: 'observations/batch',   // cloud-sync.mjs:136
    bodyKey: 'observations',          // cloud-sync.mjs:137
    selectCols: `id, memory_session_id, project, type, title, subtitle, facts,
      narrative, concepts, files_read, files_modified, prompt_number,
      discovery_tokens, created_at_epoch`,
    // cloud-sync.mjs:141-156
    toCloud: (r) => ({
      localId: String(r.id),
      memorySessionId: r.memory_session_id ?? null,
      project: r.project ?? null,
      type: r.type ?? null,
      title: r.title ?? null,
      subtitle: r.subtitle ?? null,
      facts: parseJson(r.facts),
      narrative: r.narrative ?? null,
      concepts: parseJson(r.concepts),
      filesRead: parseJson(r.files_read),
      filesModified: parseJson(r.files_modified),
      promptNumber: r.prompt_number ?? null,
      discoveryTokens: r.discovery_tokens ?? 0,
      createdAtEpoch: r.created_at_epoch ?? null,
    }),
  },
  {
    name: 'summaries',
    localTable: 'session_summaries',
    endpoint: 'summaries/batch',      // cloud-sync.mjs:183
    bodyKey: 'summaries',             // cloud-sync.mjs:184
    selectCols: `id, memory_session_id, project, request, investigated, learned,
      completed, next_steps, notes, prompt_number, discovery_tokens,
      created_at_epoch`,
    // cloud-sync.mjs:188-201
    toCloud: (r) => ({
      localId: String(r.id),
      memorySessionId: r.memory_session_id ?? null,
      project: r.project ?? null,
      request: r.request ?? null,
      investigated: r.investigated ?? null,
      learned: r.learned ?? null,
      completed: r.completed ?? null,
      nextSteps: r.next_steps ?? null,
      notes: r.notes ?? null,
      promptNumber: r.prompt_number ?? null,
      discoveryTokens: r.discovery_tokens ?? 0,
      createdAtEpoch: r.created_at_epoch ?? null,
    }),
  },
  {
    name: 'prompts',
    localTable: 'user_prompts',
    endpoint: 'prompts/batch',        // cloud-sync.mjs:224
    bodyKey: 'prompts',               // cloud-sync.mjs:225
    // prompt_text is clamped IN SQL (observed single prompts of 7.4MB from
    // pasted logs): truncating after .all() still materializes the giant
    // strings and OOMs the process, so never let them cross the FFI boundary
    // at all (cloud-sync.mjs:230-237).
    // Resolve the memory session id + project through sdk_sessions — the same
    // join the local viewer uses (prompts/get.ts). Without it the cloud viewer
    // can never attach a prompt to its session: observations are keyed by
    // memory_session_id while content_session_id is a different UUID, so the
    // old "reuse the session id" fallback produced rows that join nothing
    // (verified in prod 2026-07-12: 0 of the 50 newest sessions had a prompt).
    // LEFT JOIN, not INNER: the prompt is captured before the SDK session
    // registers its memory id, so first push may still fall back — the
    // updateMemorySessionId/ensureMemorySessionIdRegistered re-push hook
    // re-nulls synced_at once the mapping lands and the upsert repairs it.
    selectCols: `up.id AS id, up.content_session_id AS content_session_id,
      up.prompt_number AS prompt_number,
      substr(up.prompt_text, 1, ${200_000}) AS prompt_text,
      length(up.prompt_text) AS prompt_text_len,
      up.created_at AS created_at, up.created_at_epoch AS created_at_epoch,
      s.memory_session_id AS memory_session_id, s.project AS project`,
    fromSql: 'user_prompts up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id',
    rowAlias: 'up',
    // `IS` (not `=`) so two NULLs match: an orphan row (no session_db_id) and
    // a linked-but-unregistered session both SELECT and re-check as NULL.
    stampGuardSql: '(SELECT s.memory_session_id FROM sdk_sessions s WHERE s.id = user_prompts.session_db_id) IS ?',
    stampGuard: (r) => (r.memory_session_id as string | null) ?? null,
    // cloud-sync.mjs:238-250
    toCloud: (r) => ({
      localId: String(r.id),
      contentSessionId: r.content_session_id ?? null,
      memorySessionId: r.memory_session_id ?? r.content_session_id ?? 'unknown',
      project: r.project ?? 'unknown',
      promptText: r.prompt_text != null && (r.prompt_text_len as number) > 200_000
        ? String(r.prompt_text) + TRUNC_MARK
        : r.prompt_text ?? null,
      promptNumber: r.prompt_number ?? null,
      createdAtEpoch: r.created_at_epoch ?? null,
    }),
  },
];

// cloud-sync.mjs:273-281
function clampRow(mapped: CloudRow): CloudRow {
  const out = { ...mapped };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > MAX_FIELD_BYTES) {
      out[k] = v.slice(0, MAX_FIELD_BYTES) + TRUNC_MARK;
    }
  }
  return out;
}

export type CloudSyncSettingKeys = Pick<SettingsDefaults,
  | 'CLAUDE_MEM_CLOUD_SYNC_TOKEN'
  | 'CLAUDE_MEM_CLOUD_SYNC_USER_ID'
  | 'CLAUDE_MEM_CLOUD_SYNC_URL'
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
  /** First retry delay after a failed flush; doubles up to backoffMaxMs. */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** Per-request timeout — deliberately fixes the standalone client's no-timeout hang. */
  requestTimeoutMs?: number;
}

export interface CloudSyncStatus {
  configured: boolean;
  deviceId: string;
  pending: { observations: number; summaries: number; prompts: number };
  lastFlushAt: number | null;
  lastError: string | null;
}

export class CloudSync {
  private readonly db: Database;
  private readonly token: string;
  private readonly userId: string;
  private readonly url: string;
  private readonly deviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly settingsPath: string;
  private readonly legacyStatePath: string;
  private readonly debounceMs: number;
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

  constructor(db: Database, settings: CloudSyncSettingKeys, options: CloudSyncOptions = {}) {
    this.db = db;
    this.token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN ?? '';
    this.userId = settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID ?? '';
    this.url = (settings.CLAUDE_MEM_CLOUD_SYNC_URL || 'https://cmem.ai/api/pro/sync').replace(/\/+$/, ''); // cloud-sync.mjs:41
    // Human-readable device label for the dashboard's Devices panel (cloud-sync.mjs:285).
    this.deviceName = (settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME || hostname() || '').slice(0, 80);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.legacyStatePath = options.legacyStatePath ?? paths.cloudSyncState();
    this.debounceMs = options.debounceMs ?? 1_500;
    this.backoffInitialMs = options.backoffInitialMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 600_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.nextBackoffMs = this.backoffInitialMs;

    if (this.isConfigured()) {
      this.deviceId = this.resolveDeviceId(settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '');
    }
  }

  /** Active ⇔ token AND user id are both non-empty. No separate enabled flag. */
  isConfigured(): boolean {
    return this.token !== '' && this.userId !== '';
  }

  /** Configured AND holding a usable device id (resolution can fail closed). */
  private isActive(): boolean {
    return this.isConfigured() && this.deviceId !== '';
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
      url: this.url,
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
      }, this.debounceMs);
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
   * Drain everything unsynced. Single-flight: a flush arriving while one is
   * running marks a re-run instead of overlapping, so rows written mid-flush
   * are still picked up. Never rejects.
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

  private async drainKind(kind: KindSpec): Promise<void> {
    // Lane pick: a backlog deeper than one page is a bulk drain (fresh
    // install, offline catch-up, or a repair requeue like schema v40) — ride
    // the backfill lane so the server suppresses its per-row realtime
    // broadcasts and can admission-gate the burst. Small increments stay on
    // the live lane so open dashboards see them instantly.
    const lane: 'live' | 'backfill' =
      this.countPending(kind.localTable) > BATCH ? 'backfill' : 'live';
    // Loop until drained: every successful sub-batch stamps its rows, so the
    // next page naturally excludes them; a failed POST throws out of the loop.
    // `stopped` is re-checked after every await so a stop() during an
    // in-flight POST bails before the next DB touch (SELECT or stamp).
    for (;;) {
      if (this.stopped) return;
      const q = kind.rowAlias ? `${kind.rowAlias}.` : '';
      const rows = this.db.prepare(
        `SELECT ${kind.selectCols} FROM ${kind.fromSql ?? kind.localTable} WHERE ${q}synced_at IS NULL ORDER BY ${q}id LIMIT ${BATCH}`
      ).all() as LocalRow[];
      if (rows.length === 0) break;

      // Flush in size-bounded sub-batches so one page of fat rows can't
      // exceed the request-body cap (cloud-sync.mjs:337-358).
      let buf: CloudRow[] = [];
      let bufIds: number[] = [];
      let bufGuards: Array<string | null> = [];
      let bufBytes = 0;
      const send = async (): Promise<void> => {
        if (this.stopped || buf.length === 0) return;
        await this.pushBatch(kind, buf, lane);
        // stop() while the POST was in flight: the DB may already be closing,
        // so skip the stamp. The server upserts on (user_id, device_id,
        // local_id), so re-uploading these rows on next start is harmless.
        if (this.stopped) return;
        this.stampSynced(kind, bufIds, bufGuards);
        buf = [];
        bufIds = [];
        bufGuards = [];
        bufBytes = 0;
      };
      for (const r of rows) {
        let mapped = kind.toCloud(r);
        let size = JSON.stringify(mapped).length;
        if (size > MAX_FIELD_BYTES) { // cloud-sync.mjs:350 — ported as-is
          mapped = clampRow(mapped);
          size = JSON.stringify(mapped).length;
        }
        if (bufBytes + size > MAX_BODY_BYTES) {
          await send();
          if (this.stopped) return;
        }
        buf.push(mapped);
        bufIds.push(Number(r.id));
        bufGuards.push(kind.stampGuard ? kind.stampGuard(r) : null);
        bufBytes += size;
      }
      await send();
      if (this.stopped) return;
    }
  }

  // cloud-sync.mjs:287-303, plus AbortSignal.timeout — deliberately fixing the
  // standalone client's no-timeout hang.
  private async pushBatch(kind: KindSpec, rows: CloudRow[], lane: 'live' | 'backfill' = 'live'): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/${kind.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'X-User-Id': this.userId,
        'X-Device-Id': this.deviceId,
        ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
        ...(lane === 'backfill' ? { 'X-Sync-Lane': 'backfill' } : {}),
      },
      body: JSON.stringify({ [kind.bodyKey]: rows }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`cloud sync ${res.status} (${kind.name}): ${body}`);
    }
  }

  private stampSynced(kind: KindSpec, ids: number[], guards: Array<string | null>): void {
    if (ids.length === 0) return;
    const now = Date.now();
    if (kind.stampGuardSql) {
      // Per-row guarded stamp: a row whose mapping changed while the POST was
      // in flight keeps synced_at NULL and re-pushes corrected next flush.
      const stmt = this.db.prepare(
        `UPDATE ${kind.localTable} SET synced_at = ? WHERE id = ? AND ${kind.stampGuardSql}`
      );
      for (let i = 0; i < ids.length; i++) {
        stmt.run(now, ids[i], guards[i]);
      }
      return;
    }
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`UPDATE ${kind.localTable} SET synced_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...ids);
  }

  private countPending(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NULL`)
      .get() as { n: number };
    return row.n;
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
   * CRITICAL: never mint a new id while a legacy state file exists — the
   * server upserts on (user_id, device_id, local_id), so a new id forks every
   * previously uploaded row into a duplicate cloud row. If the legacy file is
   * unreadable, fail closed (sync disabled) rather than guess
   * (cloud-sync.mjs:60-81 fails closed for the same reason).
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
    // transient failure can't mint a different one and fork device identity
    // (cloud-sync.mjs:106-117).
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
