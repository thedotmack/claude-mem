// SyncClient — the pull loop of the two-lane sync (plan Phase 3 task 3).
// Polls GET {hubUrl}/v1/sync/changes with the stored cursor and feeds pages
// to SyncApply.applyOps, which advances the cursor in the same transaction as
// the applied rows (crash-safe exactly-once). This class NEVER writes the
// cursor itself — SyncApply is the single owner of sync_state.
//
// Service shape copied from TranscriptWatcher (watcher.ts): constructor /
// start() / stop(). Poll cadence:
//   - 30 s while a session is active (isSessionActive() — the worker wires
//     SessionManager.getActiveSessionCount() > 0, an existing signal);
//   - 5 min when idle;
//   - suspended entirely after 1 h with no session activity — no timer at
//     all. pullOnce() (the session-start pull) and onHeadSeq() (the push
//     piggyback) both resume the loop, so a suspended worker wakes the
//     moment anything happens.
// Every push response piggybacks head_seq (CloudSync.setHeadSeqListener →
// onHeadSeq): head_seq > cursor triggers an immediate pull without waiting
// for the timer — the free poll for the active device.
//
// FAILURE CONTRACT (same swallow-and-log posture as CloudSync.notify()):
// nothing here ever throws into a caller, blocks a write, or crashes the
// worker. Failures back off (30 s doubling to 10 min, dominating the poll
// tier) and repeated failure of the SAME page logs distinctly (wedge
// visibility) — no dead-letter machinery this phase. NO long-polling (prime
// directive #4): every request is a plain short GET with an AbortSignal
// timeout.

import { logger } from '../../utils/logger.js';
import type { SyncApply, SyncOp } from './SyncApply.js';

export interface SyncClientOptions {
  /** Sync hub base URL (CLAUDE_MEM_CLOUD_SYNC_HUB_URL). */
  hubUrl: string;
  token: string;
  userId: string;
  /** MUST be the CloudSync-resolved device id (single identity source). */
  deviceId: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Poll interval while a session is active. */
  activePollMs?: number;
  /** Poll interval while idle (no active session, < suspendAfterMs). */
  idlePollMs?: number;
  /** Suspend the loop entirely after this long with no session activity. */
  suspendAfterMs?: number;
  /** Page size for /changes (hub cap 500). */
  pageLimit?: number;
  /** Max pages per pull cycle (bounds one cycle's work). */
  maxPagesPerCycle?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Failure backoff (dominates the poll tier while failing). */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /**
   * pullOnce() skips when a pull finished this recently — protects the
   * hot context-inject path from hammering the hub on hook bursts while
   * keeping session-start data at worst this stale.
   */
  minPullGapMs?: number;
  /** Session-activity signal (worker: SessionManager.getActiveSessionCount() > 0). */
  isSessionActive?: () => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

interface ChangesPage {
  epoch?: unknown;
  ops?: unknown;
  head_seq?: unknown;
  more?: unknown;
}

export class SyncClient {
  private readonly apply: SyncApply;
  private readonly hubUrl: string;
  private readonly token: string;
  private readonly userId: string;
  private readonly deviceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly activePollMs: number;
  private readonly idlePollMs: number;
  private readonly suspendAfterMs: number;
  private readonly pageLimit: number;
  private readonly maxPagesPerCycle: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly minPullGapMs: number;
  private readonly isSessionActive: (() => boolean) | null;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private pulling = false;
  private lastActiveAt = 0;
  private lastPullFinishedAt = 0;
  /** 0 = healthy; doubles per consecutive failed cycle. */
  private backoffMs = 0;
  private failStreak = 0;
  private failCursor = -1;

  constructor(apply: SyncApply, options: SyncClientOptions) {
    const hubUrl = (options.hubUrl ?? '').trim().replace(/\/+$/, '');
    if (!hubUrl) {
      throw new Error('SyncClient requires a non-empty hubUrl (CLAUDE_MEM_CLOUD_SYNC_HUB_URL)');
    }
    if (!options.deviceId) {
      // Same fail-closed posture as CloudSync/SyncApply: pulling without an
      // identity would mis-classify our own echoes.
      throw new Error('SyncClient requires a non-empty deviceId (use the CloudSync-resolved id)');
    }
    this.apply = apply;
    this.hubUrl = hubUrl;
    this.token = options.token ?? '';
    this.userId = options.userId ?? '';
    this.deviceId = options.deviceId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.activePollMs = options.activePollMs ?? 30_000;
    this.idlePollMs = options.idlePollMs ?? 300_000;
    this.suspendAfterMs = options.suspendAfterMs ?? 3_600_000;
    this.pageLimit = options.pageLimit ?? 500;
    this.maxPagesPerCycle = options.maxPagesPerCycle ?? 40;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.backoffInitialMs = options.backoffInitialMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 600_000;
    this.minPullGapMs = options.minPullGapMs ?? 2_000;
    this.isSessionActive = options.isSessionActive ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Kick an immediate catch-up pull, then run the cadence loop. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastActiveAt = this.now(); // boot grace: idle tier, not insta-suspend
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Push piggyback (CloudSync.setHeadSeqListener): a push response revealed
   * the hub's head_seq — if it is beyond our cursor there are unseen remote
   * ops, so pull now instead of waiting out the poll timer. Never throws
   * (called from the flush path).
   */
  onHeadSeq(headSeq: number): void {
    try {
      if (this.stopped || !this.started) return;
      if (typeof headSeq !== 'number' || !Number.isFinite(headSeq)) return;
      if (headSeq <= this.apply.getCursor()) return;
      this.schedule(0); // also resumes a suspended loop
    } catch (error) {
      try {
        logger.debug('SYNC_CLIENT', 'onHeadSeq failed (non-blocking)', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* never propagate */ }
    }
  }

  /**
   * Session-start pull (plan Phase 3 task 4): one bounded catch-up cycle.
   * Hard deadline — a dead network cannot stall context injection past
   * timeoutMs. Never throws; failure = the caller proceeds with local data.
   * Counts as session activity and resumes a suspended loop.
   */
  async pullOnce(options: { timeoutMs?: number } = {}): Promise<void> {
    try {
      if (this.stopped) return;
      this.lastActiveAt = this.now();
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const skip =
        this.pulling || // a cycle is already fetching — don't stack a second
        this.now() - this.lastPullFinishedAt < this.minPullGapMs;
      if (!skip) {
        await this.pullCycle(this.now() + timeoutMs);
      }
    } catch (error) {
      // pullCycle never throws; this is a belt for the bookkeeping above.
      try {
        logger.debug('SYNC_CLIENT', 'pullOnce failed (non-blocking)', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* never propagate */ }
    } finally {
      // Re-arm the loop if it was suspended (a session is clearly starting).
      if (this.started && !this.stopped && this.timer === null) {
        const delay = this.currentDelay();
        this.schedule(delay ?? this.idlePollMs);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Loop internals
  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.(); // never hold the process open
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Background cycles have no overall deadline — each page request is
    // individually timeout-bounded and the cycle is page-capped.
    await this.pullCycle(Number.MAX_SAFE_INTEGER);
    if (this.stopped) return;
    const delay = this.currentDelay();
    if (delay === null) {
      // Suspended: no timer at all. pullOnce()/onHeadSeq() re-arm the loop.
      logger.debug('SYNC_CLIENT', 'Pull loop suspended (no session activity for over an hour)');
      return;
    }
    this.schedule(delay);
  }

  /** null ⇒ suspend. Failure backoff dominates the poll tier while failing. */
  private currentDelay(): number | null {
    const now = this.now();
    let active = false;
    try {
      active = this.isSessionActive?.() ?? false;
    } catch (error) {
      active = false;
      try {
        logger.debug('SYNC_CLIENT', 'isSessionActive callback threw; treating as inactive', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* cadence math must never throw */ }
    }
    if (active) this.lastActiveAt = now;
    let tier: number;
    if (active) {
      tier = this.activePollMs;
    } else if (now - this.lastActiveAt < this.suspendAfterMs) {
      tier = this.idlePollMs;
    } else {
      return null;
    }
    return this.backoffMs > 0 ? Math.max(tier, this.backoffMs) : tier;
  }

  /**
   * One pull cycle: page through /changes until !more, the page cap, or the
   * deadline. Single-flight. Applies each page through SyncApply (which owns
   * the cursor) and handles epoch resets by simply continuing — the cursor is
   * already back at 0, so the next iteration re-pulls from the start. Never
   * throws.
   */
  private async pullCycle(deadlineMs: number): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    try {
      let pages = 0;
      for (;;) {
        if (this.stopped) return;
        const remaining = deadlineMs - this.now();
        if (remaining <= 0) return;
        const cursor = this.apply.getCursor();

        const res = await this.fetchImpl(
          `${this.hubUrl}/v1/sync/changes?since=${cursor}&limit=${this.pageLimit}`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'X-User-Id': this.userId,
              'X-Device-Id': this.deviceId,
            },
            // Plain short request — never a held connection (directive #4).
            signal: AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs, remaining))),
          }
        );
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(`sync hub pull ${res.status}: ${body}`);
        }
        const page = await res.json() as ChangesPage | null;
        if (!page || !Array.isArray(page.ops)) {
          throw new Error('sync hub pull: malformed /changes response');
        }
        if (this.stopped) return;

        const result = this.apply.applyOps(page.ops as SyncOp[], {
          epoch: typeof page.epoch === 'string' ? page.epoch : undefined,
        });
        pages++;

        if (result.epochReset) {
          // applyOps discarded the page and reset the cursor to 0; loop to
          // re-pull from the start (apply is idempotent by design).
          if (pages >= this.maxPagesPerCycle) return;
          continue;
        }

        // A page applied — the pipeline is healthy.
        this.failStreak = 0;
        this.failCursor = -1;
        this.backoffMs = 0;

        if (page.more !== true || page.ops.length === 0) return;
        if (pages >= this.maxPagesPerCycle) return;
      }
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.pulling = false;
      this.lastPullFinishedAt = this.now();
    }
  }

  /**
   * Failure bookkeeping: back off (doubling), and when the SAME page keeps
   * failing — e.g. a malformed op that applyOps refuses, leaving the cursor
   * unmoved — log distinctly so the wedge is visible in the logs.
   */
  private recordFailure(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    let cursor = -1;
    try {
      cursor = this.apply.getCursor();
    } catch { /* DB may be closing — cursor stays -1 */ }
    if (cursor === this.failCursor) {
      this.failStreak++;
    } else {
      this.failCursor = cursor;
      this.failStreak = 1;
    }
    this.backoffMs = this.backoffMs === 0
      ? this.backoffInitialMs
      : Math.min(this.backoffMs * 2, this.backoffMaxMs);
    if (this.failStreak >= 3) {
      logger.warn('SYNC_CLIENT', 'Pull wedged: the same page keeps failing; backing off and retrying', {
        cursor,
        failStreak: this.failStreak,
        backoffMs: this.backoffMs,
      }, err);
    } else {
      logger.debug('SYNC_CLIENT', 'Pull failed (non-blocking; will retry)', {
        cursor,
        backoffMs: this.backoffMs,
      }, err);
    }
  }
}
