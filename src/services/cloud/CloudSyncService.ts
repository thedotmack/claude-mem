import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import {
  outboxEvents,
  claimPending,
  markDone,
  markQuarantined,
  bumpAttempts,
  countByStatus,
  oldestPendingAgeMs,
  enqueueOutbox,
  type OutboxRow,
  type OutboxLane,
} from './outbox.js';
import {
  isCloudEnabled,
  readCloudConfig,
  writeCloudConfig,
} from './config.js';
import { CloudClient, type CloudTelemetry } from './CloudClient.js';
import {
  readObservationPayloads,
  readSummaryPayloads,
  readPromptPayloads,
} from './mappers.js';

/**
 * Wave-2 cloud pusher.
 *
 * THE LOOP (no timers on the success path — wake is event-driven):
 *   outboxEvents 'enqueued' fires after a base-row commit  ->  wake()
 *     -> claimPending(db, 'live', N)  (atomic UPDATE..RETURNING -> inflight)
 *     -> group claimed rows by kind
 *     -> read base rows by local_id, map to camelCase payloads
 *     -> ONE coalesced batch POST per kind per burst (live headers)
 *     -> 2xx: markDone (rows deleted)
 *        4xx auth (401/403): pause lane + set authError (do not hammer)
 *        other failure: bumpAttempts (back to pending) until cap -> quarantine,
 *                       bisecting the batch to isolate the poison row(s).
 *
 * The ONLY timers anywhere are failure-path backoff and the periodic
 * anti-entropy sweep. Default-off: start() is a no-op if !isCloudEnabled(), so
 * nothing subscribes, no fetch, no timers.
 */

const LIVE_BATCH_LIMIT = 200;
const BACKFILL_BATCH_LIMIT = 750; // within the 500-1000 contract window
const ATTEMPTS_CAP = 5;
const LIVE_PUSH_TIMEOUT_MS = 900; // 700ms..1s abort window for live pushes
const BACKFILL_PUSH_TIMEOUT_MS = 15000; // backfill tolerates more latency
const ANTI_ENTROPY_INTERVAL_MS = 5 * 60 * 1000;
const BACKFILL_PAGE_SIZE = 1000; // rows enqueued per page when seeding backfill

type Kind = 'observation' | 'summary' | 'prompt';
const ROUTE_BY_KIND: Record<Kind, { route: 'observations' | 'summaries' | 'prompts'; key: 'observations' | 'summaries' | 'prompts' }> = {
  observation: { route: 'observations', key: 'observations' },
  summary: { route: 'summaries', key: 'summaries' },
  prompt: { route: 'prompts', key: 'prompts' },
};

export interface CloudSyncStatus {
  connected: boolean;
  enabled: boolean;
  syncing: boolean;
  lane: OutboxLane | null;
  outboxDepth: number;
  quarantined: number;
  lastAckAt: number | null;
  backfill: { done: boolean; cursor: Record<string, number> };
  authError: boolean;
}

/** Optional SSE hook so the worker can broadcast status without a hard dep. */
export type CloudStatusBroadcaster = (status: CloudSyncStatus) => void;

export class CloudSyncService {
  private started = false;
  private stopped = false;
  private livePushing = false;
  private livePendingWake = false;
  private backfillRunning = false;
  private authError = false;
  private currentLane: OutboxLane | null = null;
  private lastLivePushMs = 0;
  private antiEntropyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly client: CloudClient;
  private readonly wakeHandler: () => void;

  /**
   * @param autoBackfill when false, start() will NOT auto-kick backfill (callers
   *   drive startBackfill() explicitly). Defaults true in production.
   */
  constructor(
    private readonly getDb: () => Database,
    private readonly broadcast?: CloudStatusBroadcaster,
    client?: CloudClient,
    private readonly autoBackfill: boolean = true
  ) {
    this.client = client ?? new CloudClient();
    this.wakeHandler = () => this.wake();
  }

  /**
   * Start the pusher. DEFAULT-OFF GUARD: if cloud is disabled this returns
   * immediately without subscribing, fetching, or scheduling anything.
   */
  start(): void {
    if (this.started) return;
    if (!isCloudEnabled()) {
      logger.debug('CLOUD', 'CloudSyncService.start() no-op (cloud disabled)');
      return;
    }
    this.started = true;
    this.stopped = false;
    // Event-driven wake — no polling/timers on the sync path.
    outboxEvents.on('enqueued', this.wakeHandler);

    // Startup completeness pass: anti-entropy + drain anything already queued.
    // Gated on autoBackfill so a focused (test) instance can run the live lane in
    // isolation without the anti-entropy sweep re-enqueuing backfill rows.
    if (this.autoBackfill) {
      void this.runAntiEntropy().catch((err) =>
        logger.warn('CLOUD', 'startup anti-entropy failed', {}, err as Error)
      );
      this.antiEntropyTimer = setInterval(() => {
        void this.runAntiEntropy().catch((err) =>
          logger.warn('CLOUD', 'periodic anti-entropy failed', {}, err as Error)
        );
      }, ANTI_ENTROPY_INTERVAL_MS);
      this.antiEntropyTimer.unref?.();
    }

    // Kick a live drain in case rows were enqueued before we subscribed.
    this.wake();
    // Resume backfill if a previous run left it incomplete.
    if (this.autoBackfill && !readCloudConfig().backfillDone) void this.startBackfill();
    logger.info('CLOUD', 'CloudSyncService started');
  }

  /** Stop the pusher and release all listeners/timers. */
  stop(): void {
    this.stopped = true;
    if (!this.started) return;
    this.started = false;
    outboxEvents.off('enqueued', this.wakeHandler);
    if (this.antiEntropyTimer) {
      clearInterval(this.antiEntropyTimer);
      this.antiEntropyTimer = null;
    }
    logger.info('CLOUD', 'CloudSyncService stopped');
  }

  isAuthError(): boolean {
    return this.authError;
  }

  /** True while a live or backfill drain is in flight. Used by tests to await idle. */
  isBusy(): boolean {
    return this.livePushing || this.backfillRunning;
  }

  // ---- live lane --------------------------------------------------------

  /**
   * Wake the live drain. Coalesces concurrent wakes into one in-flight drain.
   * no timers on the sync path — the wake is event-driven (outboxEvents 'enqueued').
   */
  private wake(): void {
    if (this.stopped || !this.started) return; // not running
    if (this.authError) return; // lane paused on auth failure
    if (this.livePushing) {
      this.livePendingWake = true;
      return;
    }
    void this.drainLive();
  }

  private async drainLive(): Promise<void> {
    this.livePushing = true;
    this.currentLane = 'live';
    try {
      // Drain until no more pending live rows (a burst may need several batches).
      // Each iteration coalesces one batch per kind.
      let drainedAny = true;
      while (drainedAny && !this.authError && !this.stopped) {
        drainedAny = await this.pushOnce('live', LIVE_BATCH_LIMIT, LIVE_PUSH_TIMEOUT_MS);
      }
    } finally {
      this.livePushing = false;
      this.currentLane = this.backfillRunning ? 'backfill' : null;
      this.emitStatus();
      // If a wake arrived mid-drain, run again.
      if (this.livePendingWake && !this.authError) {
        this.livePendingWake = false;
        this.wake();
      }
    }
  }

  /**
   * Claim one batch on `lane`, group by kind, push each kind once.
   * Returns true if it claimed (and thus may have more) work.
   */
  private async pushOnce(lane: OutboxLane, limit: number, timeoutMs: number): Promise<boolean> {
    const db = this.getDb();
    const claimed = claimPending(db, lane, limit);
    if (claimed.length === 0) return false;

    const byKind = new Map<string, OutboxRow[]>();
    for (const row of claimed) {
      const list = byKind.get(row.kind) ?? [];
      list.push(row);
      byKind.set(row.kind, list);
    }

    const telemetry = this.telemetry(db);
    for (const [kind, rows] of byKind) {
      if (kind === 'delete' || kind === 'update') {
        await this.pushTombstones(db, kind, rows, lane, timeoutMs, telemetry);
      } else {
        await this.pushKindBatch(db, kind as Kind, rows, lane, timeoutMs, telemetry);
      }
      if (this.authError) break;
    }
    if (lane === 'live') this.lastLivePushMs = Date.now();
    return true;
  }

  /** Read + map base rows for a kind and POST one coalesced batch. */
  private async pushKindBatch(
    db: Database,
    kind: Kind,
    rows: OutboxRow[],
    lane: OutboxLane,
    timeoutMs: number,
    telemetry: CloudTelemetry
  ): Promise<void> {
    const ids = rows.map((r) => r.local_id).filter((x): x is number => x != null);
    const payloads = this.readPayloads(db, kind, ids);
    if (payloads.length === 0) {
      // Base rows vanished (e.g. deleted before push) — nothing to send, drop.
      markDone(db, rows.map((r) => r.id));
      return;
    }
    const { route, key } = ROUTE_BY_KIND[kind];
    const res = await this.client.postBatch(route, key, payloads, lane, timeoutMs, telemetry);

    if (res.ok) {
      markDone(db, rows.map((r) => r.id));
      this.recordAck();
      return;
    }
    if (res.status === 401 || res.status === 403) {
      this.enterAuthError(db, rows);
      return;
    }
    if (res.queued) {
      // Backfill admission gate full — revert to pending, back off briefly.
      bumpAttempts(db, rows.map((r) => r.id));
      await this.backoff(rows);
      return;
    }
    // Generic failure: if a single row, it may be poison; otherwise retry/bisect.
    await this.handleBatchFailure(db, kind, rows, lane, timeoutMs, telemetry);
  }

  /**
   * On a batch failure isolate the cause:
   *   - >1 row  => BISECT immediately: split in half and push each half, so a
   *                poison row is narrowed to a single row. The clean half succeeds
   *                and is markDone'd; only the failing half keeps narrowing.
   *   - 1 row   => bump attempts; retry with backoff until ATTEMPTS_CAP, then
   *                markQuarantined (poison containment). A transient single-row
   *                failure thus self-heals; a truly poison row is quarantined and
   *                the rest of the queue proceeds.
   * This is the anti-entropy / poison-containment guarantee.
   */
  private async handleBatchFailure(
    db: Database,
    kind: Kind,
    rows: OutboxRow[],
    lane: OutboxLane,
    timeoutMs: number,
    telemetry: CloudTelemetry
  ): Promise<void> {
    if (this.stopped) return;

    if (rows.length === 1) {
      bumpAttempts(db, rows.map((r) => r.id));
      const attempts = rows[0].attempts + 1;
      if (attempts >= ATTEMPTS_CAP) {
        markQuarantined(db, [rows[0].id]);
        logger.warn('CLOUD', 'Quarantined poison row', { id: rows[0].id, kind, attempts });
        return;
      }
      await this.backoff(rows);
      if (this.stopped) return;
      // Retry the single row directly.
      const payloads = this.readPayloads(db, kind, [rows[0].local_id as number]);
      const { route, key } = ROUTE_BY_KIND[kind];
      const retry = await this.client.postBatch(route, key, payloads, lane, timeoutMs, telemetry);
      if (retry.ok) {
        markDone(db, [rows[0].id]);
        this.recordAck();
      } else if (retry.status === 401 || retry.status === 403) {
        this.enterAuthError(db, rows);
      } else {
        // Re-read the (bumped) attempts and recurse so the cap is honored.
        const fresh = db.prepare('SELECT * FROM cloud_outbox WHERE id = ?').get(rows[0].id) as OutboxRow | undefined;
        if (fresh) await this.handleBatchFailure(db, kind, [fresh], lane, timeoutMs, telemetry);
      }
      return;
    }

    // Bisect: split and push each half. A poison row narrows to a single row.
    const mid = Math.floor(rows.length / 2);
    const halves = [rows.slice(0, mid), rows.slice(mid)];
    for (const half of halves) {
      if (half.length === 0 || this.stopped) continue;
      const ids = half.map((r) => r.local_id).filter((x): x is number => x != null);
      const payloads = this.readPayloads(db, kind, ids);
      const { route, key } = ROUTE_BY_KIND[kind];
      const res = await this.client.postBatch(route, key, payloads, lane, timeoutMs, telemetry);
      if (res.ok) {
        markDone(db, half.map((r) => r.id));
        this.recordAck();
      } else if (res.status === 401 || res.status === 403) {
        this.enterAuthError(db, half);
        return;
      } else {
        await this.handleBatchFailure(db, kind, half, lane, timeoutMs, telemetry);
      }
    }
  }

  private async pushTombstones(
    db: Database,
    kind: 'delete' | 'update',
    rows: OutboxRow[],
    lane: OutboxLane,
    timeoutMs: number,
    telemetry: CloudTelemetry
  ): Promise<void> {
    // Group by target_table; tombstone items carry just { localId } for deletes.
    const byTable = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const table = (row.target_table ?? 'observation') as string;
      const list = byTable.get(table) ?? [];
      list.push(row);
      byTable.set(table, list);
    }
    for (const [table, tableRows] of byTable) {
      const items = tableRows.map((r) => ({ localId: r.local_id }));
      const res = await this.client.postTombstone(
        table as 'observation' | 'summary' | 'prompt',
        kind,
        items,
        lane,
        timeoutMs,
        telemetry
      );
      if (res.ok) {
        markDone(db, tableRows.map((r) => r.id));
        this.recordAck();
      } else if (res.status === 401 || res.status === 403) {
        this.enterAuthError(db, tableRows);
        return;
      } else {
        bumpAttempts(db, tableRows.map((r) => r.id));
        const maxAttempts = Math.max(...tableRows.map((r) => r.attempts)) + 1;
        if (maxAttempts >= ATTEMPTS_CAP) markQuarantined(db, tableRows.map((r) => r.id));
        await this.backoff(tableRows);
      }
    }
  }

  private readPayloads(db: Database, kind: Kind, ids: number[]): unknown[] {
    switch (kind) {
      case 'observation':
        return readObservationPayloads(db, ids);
      case 'summary':
        return readSummaryPayloads(db, ids);
      case 'prompt':
        return readPromptPayloads(db, ids);
    }
  }

  private enterAuthError(db: Database, rows: OutboxRow[]): void {
    // Revert claimed rows so they re-drain once re-authed; pause the lane.
    bumpAttempts(db, rows.map((r) => r.id));
    this.authError = true;
    logger.warn('CLOUD', 'Auth rejected (401/403) — pausing sync lane');
    this.emitStatus();
  }

  /** Clear the auth-error pause (called after a successful reconnect). */
  clearAuthError(): void {
    if (!this.authError) return;
    this.authError = false;
    logger.info('CLOUD', 'Auth error cleared — resuming sync');
    this.wake();
  }

  /**
   * Failure-path backoff (the ONLY success-adjacent timer): first retry 100-200ms
   * jitter, exponential from attempt 3. Derived from the max attempts in the batch.
   */
  private backoff(rows: OutboxRow[]): Promise<void> {
    const attempt = Math.max(0, ...rows.map((r) => r.attempts));
    let delay: number;
    if (attempt <= 1) {
      delay = 100 + Math.floor(Math.random() * 100); // 100-200ms jitter
    } else {
      delay = Math.min(100 * 2 ** (attempt - 1), 10000);
    }
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private recordAck(): void {
    const now = Date.now();
    writeCloudConfig({ lastAckAt: now });
  }

  private telemetry(db: Database): CloudTelemetry {
    const counts = countByStatus(db);
    const depth = (counts.pending ?? 0) + (counts.inflight ?? 0);
    return {
      outboxDepth: depth,
      oldestPendingAgeSec: Math.round(oldestPendingAgeMs(db) / 1000),
    };
  }

  // ---- backfill lane ----------------------------------------------------

  /**
   * Seed the backfill lane with the user's ENTIRE history newest-first, in pages,
   * then drain it over the backfill lane (X-Sync-Lane: backfill) alongside (never
   * blocking) the live lane. Completion = per-project count reconciliation.
   */
  async startBackfill(): Promise<void> {
    if (this.backfillRunning) return;
    if (this.stopped || !isCloudEnabled() || this.authError) return;
    this.backfillRunning = true;
    try {
      const db = this.getDb();
      this.seedBackfillRows(db);
      this.emitStatus();
      // Drain the backfill lane to exhaustion (separate from live). `stopped` is
      // checked each iteration so stop() (and a closed db) cleanly halts the loop.
      let drainedAny = true;
      while (drainedAny && !this.stopped && !this.authError && isCloudEnabled()) {
        drainedAny = await this.pushOnce('backfill', BACKFILL_BATCH_LIMIT, BACKFILL_PUSH_TIMEOUT_MS);
        // Adaptive throttle: only slow down if live latency is degrading.
        if (drainedAny && this.liveLatencyDegraded()) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!this.stopped) await this.checkBackfillComplete(db);
    } finally {
      this.backfillRunning = false;
      if (!this.stopped) this.emitStatus();
    }
  }

  /**
   * Insert backfill outbox rows for every base row not already enqueued, newest
   * first, advancing a descending per-kind cursor persisted in cloud-config so a
   * restart resumes. Bounded per call (one page per kind) to avoid a huge txn.
   */
  private seedBackfillRows(db: Database): void {
    const cfg = readCloudConfig();
    const cursor = { ...(cfg.backfillCursor ?? {}) } as Record<Kind, number | undefined>;
    const kinds: Kind[] = ['observation', 'summary', 'prompt'];
    const tableByKind: Record<Kind, string> = {
      observation: 'observations',
      summary: 'session_summaries',
      prompt: 'user_prompts',
    };
    for (const kind of kinds) {
      const table = tableByKind[kind];
      // Cursor = highest local_id NOT YET enqueued going down; start above max.
      const startBelow =
        cursor[kind] ??
        ((db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS m FROM ${table}`).get() as { m: number }).m);
      const rows = db
        .prepare(`SELECT id, created_at_epoch FROM ${table} WHERE id < ? ORDER BY id DESC LIMIT ?`)
        .all(startBelow, BACKFILL_PAGE_SIZE) as Array<{ id: number; created_at_epoch: number }>;
      if (rows.length === 0) continue;
      const insert = db.transaction(() => {
        for (const row of rows) {
          enqueueOutbox(db, {
            kind,
            localId: row.id,
            lane: 'backfill',
            createdAtEpoch: row.created_at_epoch,
          });
        }
      });
      insert();
      cursor[kind] = rows[rows.length - 1].id; // lowest id we just enqueued
    }
    writeCloudConfig({ backfillCursor: cursor as Record<string, number> });
  }

  /**
   * Per-project reconciliation: for each local project, sum the localIds the
   * cloud reports via GET /status and compare to local counts per kind. When all
   * match, set backfill_done and emit a fully_synced status.
   */
  private async checkBackfillComplete(db: Database): Promise<void> {
    // Don't claim "done" while base rows are still un-enqueued.
    const cfg = readCloudConfig();
    const cursor = cfg.backfillCursor ?? {};
    const remaining =
      ((db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id < ?').get((cursor.observation ?? 0)) as { n: number }).n) +
      ((db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE id < ?').get((cursor.summary ?? 0)) as { n: number }).n) +
      ((db.prepare('SELECT COUNT(*) AS n FROM user_prompts WHERE id < ?').get((cursor.prompt ?? 0)) as { n: number }).n);
    const queued = (countByStatus(db).pending ?? 0) + (countByStatus(db).inflight ?? 0);
    if (remaining > 0 || queued > 0) return; // more to seed/drain

    const projects = (db
      .prepare('SELECT DISTINCT project FROM observations UNION SELECT DISTINCT project FROM session_summaries')
      .all() as Array<{ project: string }>).map((r) => r.project).filter(Boolean);

    for (const project of projects) {
      const { result } = await this.client.getStatus(project);
      if (!result) return; // can't verify — try again next sweep
      const localObs = (db.prepare('SELECT COUNT(*) AS n FROM observations WHERE project = ?').get(project) as { n: number }).n;
      const localSum = (db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE project = ?').get(project) as { n: number }).n;
      if (result.observations.length < localObs || result.summaries.length < localSum) {
        // Mismatch — re-enqueue from lowest missing on the backfill lane.
        this.reEnqueueMismatch(db, project, result.observations, result.summaries);
        return;
      }
    }
    writeCloudConfig({ backfillDone: true });
    logger.info('CLOUD', 'Backfill reconciliation complete — fully synced');
    this.broadcast?.({ ...this.buildStatus(db), backfill: { done: true, cursor: cursor as Record<string, number> } });
  }

  private reEnqueueMismatch(
    db: Database,
    project: string,
    cloudObs: number[],
    cloudSum: number[]
  ): void {
    const cloudObsSet = new Set(cloudObs);
    const cloudSumSet = new Set(cloudSum);
    const missingObs = (db.prepare('SELECT id, created_at_epoch FROM observations WHERE project = ?').all(project) as Array<{ id: number; created_at_epoch: number }>).filter((r) => !cloudObsSet.has(r.id));
    const missingSum = (db.prepare('SELECT id, created_at_epoch FROM session_summaries WHERE project = ?').all(project) as Array<{ id: number; created_at_epoch: number }>).filter((r) => !cloudSumSet.has(r.id));
    const insert = db.transaction(() => {
      for (const r of missingObs) enqueueOutbox(db, { kind: 'observation', localId: r.id, lane: 'backfill', createdAtEpoch: r.created_at_epoch });
      for (const r of missingSum) enqueueOutbox(db, { kind: 'summary', localId: r.id, lane: 'backfill', createdAtEpoch: r.created_at_epoch });
    });
    insert();
    logger.info('CLOUD', 'Anti-entropy re-enqueued mismatched rows', { project, observations: missingObs.length, summaries: missingSum.length });
  }

  private liveLatencyDegraded(): boolean {
    // Heuristic: if the live lane has pending work, yield to it.
    try {
      const counts = countByStatus(this.getDb());
      return (counts.pending ?? 0) > 0 && this.livePushing;
    } catch {
      return false;
    }
  }

  // ---- anti-entropy + sync-now -----------------------------------------

  /**
   * Completeness guarantee: compare local count per kind/project vs cloud /status
   * and re-enqueue missing rows on the backfill lane. Runs on startup + periodically.
   */
  async runAntiEntropy(): Promise<void> {
    if (this.stopped || !isCloudEnabled() || this.authError) return;
    const db = this.getDb();
    const projects = (db
      .prepare('SELECT DISTINCT project FROM observations UNION SELECT DISTINCT project FROM session_summaries')
      .all() as Array<{ project: string }>).map((r) => r.project).filter(Boolean);
    for (const project of projects) {
      const { result, status } = await this.client.getStatus(project);
      if (status === 401 || status === 403) {
        this.authError = true;
        this.emitStatus();
        return;
      }
      if (!result) continue;
      this.reEnqueueMismatch(db, project, result.observations, result.summaries);
    }
    // Drain whatever got re-enqueued.
    if (!this.backfillRunning) void this.startBackfill();
  }

  /** Force a live drain + anti-entropy pass (POST /api/cloud/sync-now). */
  async syncNow(): Promise<void> {
    this.clearAuthError();
    this.wake();
    await this.runAntiEntropy();
  }

  // ---- status -----------------------------------------------------------

  /** Public status accessor for routes — resolves the db internally. */
  buildStatusPublic(): CloudSyncStatus {
    return this.buildStatus(this.getDb());
  }

  buildStatus(db: Database): CloudSyncStatus {
    const cfg = readCloudConfig();
    const counts = countByStatus(db);
    return {
      connected: Boolean(cfg.userId && cfg.deviceId && cfg.setupToken),
      enabled: cfg.enabled === true,
      syncing: this.livePushing || this.backfillRunning,
      lane: this.currentLane,
      outboxDepth: (counts.pending ?? 0) + (counts.inflight ?? 0),
      quarantined: counts.quarantined ?? 0,
      lastAckAt: cfg.lastAckAt ?? null,
      backfill: { done: cfg.backfillDone === true, cursor: (cfg.backfillCursor ?? {}) as Record<string, number> },
      authError: this.authError,
    };
  }

  private emitStatus(): void {
    if (!this.broadcast) return;
    try {
      this.broadcast(this.buildStatus(this.getDb()));
    } catch {
      // Broadcast is best-effort; never let it break the sync loop.
    }
  }
}
