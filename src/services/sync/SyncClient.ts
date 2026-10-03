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
//     all, and the Realtime socket is torn down with it (an idle client
//     needs no live updates, and a held socket costs a Realtime connection
//     slot for nothing). pullOnce() (the
//     session-start pull) and onHeadSeq() (the push piggyback) both resume
//     the loop AND reconnect the socket, so a suspended worker wakes the
//     moment anything happens.
// Every push response piggybacks head_seq (CloudSync.setHeadSeqListener →
// onHeadSeq): head_seq > cursor triggers an immediate pull without waiting
// for the timer — the free poll for the active device.
//
// LIVE UPDATES — SUPABASE REALTIME (plan Phase 11): when enabled
// (CLAUDE_MEM_CLOUD_SYNC_WS, default on; 'false' disables live updates) the
// client fetches short-lived Realtime credentials from
// POST {hub}/v1/sync/realtime-token, opens one Bun-native WebSocket to the
// Supabase Realtime endpoint (Phoenix protocol vsn 1.0.0 — no npm client) and
// joins the private broadcast channel `user:<id>`. The channel is STRICTLY
// advisory: it only ever carries {type:'advance', epoch, head_seq}, which
// triggers the ordinary HTTP pull. Nothing durable rides it, and the cursor
// is NEVER written outside SyncApply. An epoch mismatch or a malformed frame
// is an anomaly: drop the socket and run one HTTP pullOnce() (self-heal).
// Liveness, not deadlines: a Phoenix heartbeat every ≤25 s must be answered
// before the next one is sent, or the socket is declared dead and replaced;
// a new connection whose join gets no phx_reply within
// REALTIME_JOIN_REPLY_TIMEOUT_MS (10 s) is likewise dropped and reconnected.
// The access token is re-minted at ~80 % of its lifetime and handed to the
// open channel (`access_token` event) — no reconnect. Reconnects use
// full-jitter backoff (1 s base, 60 s cap) and always fetch fresh
// credentials. While the channel is JOINED the active poll tier stretches to
// the idle tier (polling is the safety net); a disconnect restores it.
//
// Availability: a 404 from realtime-token means the server has no Realtime —
// stay on HTTP polling and re-probe hourly. 401/403 enter the same auth pause
// as pulls. The server's `X-Sync-Mode: poll` header is aimed at OLD clients
// (it shut off the retired hub WebSocket) and is deliberately ignored here:
// it must never disable Realtime. Total failure of every socket code path
// leaves HTTP-only behavior intact.
//
// FAILURE CONTRACT (same swallow-and-log posture as CloudSync.notify()):
// nothing here ever throws into a caller, blocks a write, or crashes the
// worker. Failures back off (30 s doubling to 10 min, dominating the poll
// tier; unforced pullOnce() calls honor it too) and repeated failure of the
// SAME page logs distinctly (wedge visibility). A single op that can never
// apply is not a page failure: SyncApply sets it aside in
// sync_pull_quarantine and the cursor moves on. NO long-polling (prime
// directive #4): every request is a plain short GET with an AbortSignal
// timeout.

import { logger } from '../../utils/logger.js';
import type { SyncApply, SyncOp, UndecodableOp } from './SyncApply.js';
import {
  assertCanonicalDecimal,
  canonicalDecimalToSafeInteger,
  canonicalJson,
  compareCanonicalDecimals,
  decodeHubChange,
  type CanonicalHubChange,
} from './CanonicalContent.js';

/**
 * A new Realtime connection must have its channel join acknowledged
 * (phx_reply) within this long of the socket being created — covering both a
 * connect that never opens and an open socket whose join is never answered.
 * Otherwise the socket is dropped and reconnected with backoff.
 */
export const REALTIME_JOIN_REPLY_TIMEOUT_MS = 10_000;

const LOCAL_DECIMAL_FIELDS = new Set(['created_at_epoch', 'discovery_tokens', 'prompt_number']);
const LOCAL_JSON_FIELDS = new Set(['concepts', 'facts', 'files_edited', 'files_modified', 'files_read']);

/** Convert lossless wire types back to the native SQLite column shapes. */
function localPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload === null) return null;
  const result: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(result)) {
    if (value === null) continue;
    if (LOCAL_DECIMAL_FIELDS.has(key)) {
      result[key] = canonicalDecimalToSafeInteger(value, key);
    } else if (LOCAL_JSON_FIELDS.has(key)) {
      result[key] = canonicalJson(value);
    } else if (key === 'metadata') {
      result[key] = canonicalJson(value);
    }
  }
  return result;
}

function decodeChanges(values: unknown[]): Array<SyncOp | UndecodableOp> {
  return values.map((value): SyncOp | UndecodableOp => {
    let decoded: ReturnType<typeof decodeHubChange>;
    try {
      decoded = decodeHubChange(value as CanonicalHubChange);
    } catch (error) {
      // One change we cannot decode must not fail the whole page forever:
      // keep its seq (the page stays contiguous) and let SyncApply set it
      // aside. A change without a valid seq is a broken page — that throws.
      const seq = assertCanonicalDecimal((value as { seq?: unknown } | null)?.seq, { positive: true });
      return {
        seq,
        undecodable: error instanceof Error ? error.message : String(error),
        raw: JSON.stringify(value),
      };
    }
    const body = decoded.body;
    return {
      seq: decoded.seq,
      kind: body.kind,
      origin_device: body.origin_device_id,
      origin_id: body.origin_local_id ?? body.id.slice('mutation:'.length),
      rev: body.entity_rev,
      body: canonicalJson(body.kind === 'mutation' ? body.mutation : localPayload(body.payload)),
      server_ts: decoded.server_ts,
      entity_id: body.id,
      entity_rev: body.entity_rev,
      operation_sha256: decoded.operation_sha256,
      deleted: body.deleted,
      deleted_at: body.deleted_at,
    };
  });
}

/**
 * Structural WebSocket surface the client needs — satisfied by Bun's global
 * WebSocket and by test doubles. Injectable via
 * SyncClientOptions.webSocketImpl (the fetchImpl idiom).
 */
export interface SyncSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Bun extension: hard-drop without a close handshake. */
  terminate?(): void;
}

export type SyncWebSocketConstructor = new (url: string) => SyncSocketLike;

/** Credentials from POST /v1/sync/realtime-token, normalized. */
interface RealtimeGrant {
  accessToken: string;
  expiresAtMs: number;
  /** wss://…/realtime/v1/websocket?apikey=…&vsn=1.0.0 */
  socketUrl: string;
  /** Phoenix topic, already prefixed: `realtime:user:<id>`. */
  channelTopic: string;
}

class RealtimeTokenError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Phoenix vsn 1.0.0 frame (object form). */
interface PhoenixFrame {
  topic?: unknown;
  event?: unknown;
  payload?: unknown;
  ref?: unknown;
  join_ref?: unknown;
}

export interface SyncClientOptions {
  /** Sync hub base URL (CLAUDE_MEM_CLOUD_SYNC_HUB_URL). */
  hubUrl: string;
  token: string;
  userId: string;
  /** MUST be the CloudSync-resolved device id (single identity source). */
  deviceId: string;
  /** Human-readable Hub device label (CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME). */
  deviceName?: string;
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
   * Pause after a 401/403 (bad token or lapsed subscription): the same
   * credentials cannot succeed, so pulls re-check at this interval and the
   * Realtime socket stays down meanwhile. Default 1h.
   */
  authPauseMs?: number;
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
  /**
   * Live-updates gate (CLAUDE_MEM_CLOUD_SYNC_WS ≠ 'false'): subscribe to the
   * Supabase Realtime channel. Defaults to enabled; forced off when no
   * WebSocket implementation is available. Disabled ⇒ HTTP polling only.
   */
  wsEnabled?: boolean;
  /** Injectable WebSocket constructor (tests). Defaults to Bun's global. */
  webSocketImpl?: SyncWebSocketConstructor;
  /** Join-reply deadline per connection (default REALTIME_JOIN_REPLY_TIMEOUT_MS). */
  wsJoinReplyTimeoutMs?: number;
  /** Phoenix heartbeat cadence (≤25 s); an unanswered heartbeat drops the socket. */
  wsPingIntervalMs?: number;
  /** Reconnect full-jitter backoff: random(0, min(cap, base·2^attempt)). */
  wsBackoffBaseMs?: number;
  wsBackoffMaxMs?: number;
  /**
   * Socket-liveness listener — the thin coupling that lets CloudSync drop its
   * push debounce to the fast tier while the socket is live (Phase 4 task 3).
   * Called with true on open, false on close/self-heal/stop. Never trusted:
   * a throwing listener is swallowed.
   */
  onSocketLiveChange?: (live: boolean) => void;
  /** Injectable RNG for the reconnect jitter (tests). */
  random?: () => number;
  /** After realtime-token answers 404 (no Realtime on the server), re-probe this often. Default 1h. */
  realtimeUnavailableRetryMs?: number;
}

interface ChangesPage {
  protocol_version?: unknown;
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
  private readonly deviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly activePollMs: number;
  private readonly idlePollMs: number;
  private readonly suspendAfterMs: number;
  private readonly pageLimit: number;
  private readonly maxPagesPerCycle: number;
  private readonly requestTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly authPauseMs: number;
  /** Epoch ms until which the socket lane stays down after a 401/403 pull. */
  private authPausedUntil = 0;
  private readonly minPullGapMs: number;
  private readonly isSessionActive: (() => boolean) | null;
  private readonly now: () => number;

  private readonly wsEnabled: boolean;
  private readonly webSocketImpl: SyncWebSocketConstructor | null;
  private readonly wsPingIntervalMs: number;
  private readonly wsJoinReplyTimeoutMs: number;
  private readonly wsBackoffBaseMs: number;
  private readonly wsBackoffMaxMs: number;
  private readonly onSocketLiveChange: ((live: boolean) => void) | null;
  private readonly random: () => number;
  private readonly realtimeUnavailableRetryMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private pulling = false;
  private lastActiveAt = 0;
  private lastPullFinishedAt = 0;
  /** 0 = healthy; doubles per consecutive failed cycle. */
  private backoffMs = 0;
  /** Hints and socket recovery must wait for the failed HTTP pull's retry. */
  private transientRetryAt = 0;
  private failStreak = 0;
  private failCursor: string | null = null;

  // Realtime state (all of it disposable — prime directive #2).
  private socket: SyncSocketLike | null = null;
  /** True once the channel join is acknowledged (status ok). */
  private socketLive = false;
  private wsAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Armed at socket creation; cleared by the join reply or teardown. */
  private joinReplyTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** A token fetch for a new connection is in flight. */
  private connecting = false;
  /** Bumped by every teardown: async work from an older connection is inert. */
  private realtimeGeneration = 0;
  private realtimeGrant: RealtimeGrant | null = null;
  /** Phoenix ref counter, restarted per connection (join is ref "1"). */
  private realtimeRef = 0;
  private joinRef: string | null = null;
  /** Ref of the last heartbeat not yet answered; still set at the next beat ⇒ dead. */
  private pendingHeartbeatRef: string | null = null;
  /** realtime-token answered 404: the server has no Realtime. */
  private realtimeUnavailable = false;
  private realtimeUnavailableUntil = 0;
  /** True while the pull loop is suspended (socket torn down with it). */
  private suspended = false;

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
    this.deviceName = (options.deviceName ?? '').trim().slice(0, 80);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.activePollMs = options.activePollMs ?? 30_000;
    this.idlePollMs = options.idlePollMs ?? 300_000;
    this.suspendAfterMs = options.suspendAfterMs ?? 3_600_000;
    this.pageLimit = options.pageLimit ?? 500;
    this.maxPagesPerCycle = options.maxPagesPerCycle ?? 40;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.backoffInitialMs = options.backoffInitialMs ?? 30_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 600_000;
    this.authPauseMs = options.authPauseMs ?? 3_600_000;
    this.minPullGapMs = options.minPullGapMs ?? 2_000;
    this.isSessionActive = options.isSessionActive ?? null;
    this.now = options.now ?? Date.now;

    // Realtime config. The gate: setting-enabled AND an implementation
    // exists (Bun's global WebSocket, or an injected test double). No
    // implementation ⇒ silently HTTP-only — never a construction failure.
    this.webSocketImpl = options.webSocketImpl
      ?? ((globalThis as { WebSocket?: unknown }).WebSocket as SyncWebSocketConstructor | undefined)
      ?? null;
    this.wsEnabled = (options.wsEnabled ?? true) && this.webSocketImpl !== null;
    // Supabase Realtime closes sockets that skip heartbeats; ≤25 s is the
    // documented client cadence.
    this.wsPingIntervalMs = Math.min(options.wsPingIntervalMs ?? 25_000, 25_000);
    this.wsJoinReplyTimeoutMs = options.wsJoinReplyTimeoutMs ?? REALTIME_JOIN_REPLY_TIMEOUT_MS;
    this.wsBackoffBaseMs = options.wsBackoffBaseMs ?? 1_000;
    this.wsBackoffMaxMs = options.wsBackoffMaxMs ?? 60_000;
    this.onSocketLiveChange = options.onSocketLiveChange ?? null;
    this.random = options.random ?? Math.random;
    this.realtimeUnavailableRetryMs = options.realtimeUnavailableRetryMs ?? 3_600_000;
  }

  /** Kick an immediate catch-up pull, then run the cadence loop. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastActiveAt = this.now(); // boot grace: idle tier, not insta-suspend
    this.schedule(0);
    // Realtime, fully firewalled: a throwing connect path must never
    // take the pull loop down with it.
    try {
      this.connectSocket();
    } catch (error) {
      try {
        logger.debug('SYNC_CLIENT', 'Socket startup failed (advisory; HTTP polling unaffected)', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* never propagate */ }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setSocketLive(false);
    this.teardownSocket();
  }

  /**
   * X-Sync-Mode hint from CloudSync's push responses (setSyncModeListener
   * wiring in the worker). Intentionally ignored: the Supabase server stamps
   * `poll` on every response to switch OFF the retired hub WebSocket in old
   * clients. Realtime is governed only by CLAUDE_MEM_CLOUD_SYNC_WS and by
   * realtime-token availability, so the header must not disable it.
   */
  onSyncModeHint(_mode: string | null): void {
    /* retired-hub signal — see the doc comment */
  }

  /** True while live updates are off (setting disabled, or no Realtime on the server). */
  isPollModeOnly(): boolean {
    return !this.wsEnabled || this.realtimeUnavailable;
  }

  /**
   * Push piggyback (CloudSync.setHeadSeqListener): a push response revealed
   * the hub's head_seq — if it is beyond our cursor there are unseen remote
   * ops, so pull now instead of waiting out the poll timer. Never throws
   * (called from the flush path).
   */
  onHeadSeq(headSeq: string): void {
    try {
      if (this.stopped || !this.started) return;
      // head_seq only arrives from a SUCCESSFUL push: the server accepts
      // these credentials again, so lift a pull-side auth pause now.
      this.clearAuthPause();
      const head = assertCanonicalDecimal(headSeq);
      if (compareCanonicalDecimals(head, this.apply.getCursor()) <= 0) return;
      this.resumeIfSuspended(); // socket back up alongside the loop
      this.schedule(Math.max(0, this.transientRetryAt - this.now()));
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
   *
   * Unforced calls (the context-inject hook) skip while the failure backoff
   * is running: the background loop owns that retry. Without this, every
   * hook re-fetched the same failing page — 2,000+ times in one wedge — and
   * loaded a hub that was already failing. `force` bypasses the backoff and
   * the min-gap skip; socket callers check the backoff themselves first.
   * Single-flight holds.
   */
  async pullOnce(options: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
    try {
      if (this.stopped) return;
      this.lastActiveAt = this.now();
      this.resumeIfSuspended(); // session activity: socket back up too
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const skip =
        this.pulling || // a cycle is already fetching — don't stack a second
        (!options.force && (
          this.transientRetryAt > this.now()
          || this.now() - this.lastPullFinishedAt < this.minPullGapMs
        ));
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

  /** Lift the 401/403 pause (credentials proven good) and restore the normal ladder. */
  private clearAuthPause(): void {
    if (this.authPausedUntil === 0) return;
    this.authPausedUntil = 0;
    this.backoffMs = 0;
    this.transientRetryAt = 0;
    logger.info('SYNC_CLIENT', 'Sync credentials accepted again; resuming pulls and live updates');
    if (this.started && !this.stopped) this.connectSocket();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const pausedFor = Math.max(this.authPausedUntil, this.transientRetryAt) - this.now();
    if (pausedFor > 0) {
      // Early hints wait out the existing deadline without extending it.
      this.schedule(pausedFor);
      return;
    }
    // Background cycles have no overall deadline — each page request is
    // individually timeout-bounded and the cycle is page-capped.
    await this.pullCycle(Number.MAX_SAFE_INTEGER);
    if (this.stopped) return;
    const delay = this.currentDelay();
    if (delay === null) {
      // Suspended: no timer AND no socket. An idle client needs no live
      // updates, and a held socket would occupy a Realtime connection slot
      // (plan-capped) for nothing.
      // pullOnce()/onHeadSeq() re-arm the loop and reconnect the socket.
      this.suspended = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.teardownSocket();
      this.setSocketLive(false);
      logger.debug('SYNC_CLIENT', 'Pull loop suspended (no session activity for over an hour) — Realtime socket closed');
      return;
    }
    this.schedule(delay);
  }

  /**
   * Leaving suspension (session activity, a session-start pull, or a push
   * piggyback): re-open the Realtime socket the suspend branch tore down.
   * All connectSocket gates (stopped, poll mode, existing socket, wsEnabled)
   * still apply; the backoff ladder restarts fresh.
   */
  private resumeIfSuspended(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.wsAttempts = 0;
    this.connectSocket();
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
      // Socket connected ⇒ stretch to the idle tier (plan Phase 4 task 2):
      // fan-out is the fast path now; polling is only the safety net.
      tier = this.socketLive ? this.idlePollMs : this.activePollMs;
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
    // Auth pause (401/403): every lane waits it out, including forced and
    // session-start pulls — the same credentials cannot succeed sooner.
    if (this.authPausedUntil > this.now()) return;
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
            headers: this.hubHeaders(),
            // Plain short request — never a held connection (directive #4).
            signal: AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs, remaining))),
          }
        );
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(`sync hub pull ${res.status}: ${body}`);
        }
        const page = await res.json() as ChangesPage | null;
        if (!page || page.protocol_version !== 2 || !Array.isArray(page.ops)) {
          throw new Error('sync hub pull: malformed /changes response');
        }
        const epoch = assertCanonicalDecimal(page.epoch);
        assertCanonicalDecimal(page.head_seq);
        if (typeof page.more !== 'boolean') throw new Error('sync hub pull: more must be boolean');
        if (this.stopped) return;

        const decodedOps = decodeChanges(page.ops);
        const result = this.apply.applyOps(decodedOps, {
          epoch,
          requireContiguous: true,
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
        this.failCursor = null;
        this.backoffMs = 0;
        this.transientRetryAt = 0;
        this.clearAuthPause();

        if (page.more !== true || decodedOps.length === 0) return;
        if (pages >= this.maxPagesPerCycle) return;
      }
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.pulling = false;
      this.lastPullFinishedAt = this.now();
    }
  }

  // -------------------------------------------------------------------------
  // Supabase Realtime live updates (plan Phase 11)
  //
  // Everything below is disposable: any failure tears the socket down and
  // schedules a jittered reconnect (data anomalies also run one HTTP pull).
  // The HTTP lanes never depend on any of it.
  // -------------------------------------------------------------------------

  /** True while the Realtime channel is joined (test/status introspection). */
  isSocketLive(): boolean {
    return this.socketLive;
  }

  private hubHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'X-User-Id': this.userId,
      'X-Device-Id': this.deviceId,
      ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
    };
  }

  private connectSocket(): void {
    if (!this.wsEnabled || this.stopped || this.suspended || this.socket || this.connecting || !this.webSocketImpl) return;
    // Auth pause: rejected credentials cannot mint a Realtime token either.
    if (this.authPausedUntil > this.now()) return;
    const unavailableFor = this.realtimeUnavailableUntil - this.now();
    if (unavailableFor > 0) {
      // No Realtime on the server: keep (or re-arm) the hourly re-probe only.
      this.scheduleReconnect(unavailableFor);
      return;
    }
    this.connecting = true;
    void this.openRealtime(this.realtimeGeneration);
  }

  private async openRealtime(generation: number): Promise<void> {
    let grant: RealtimeGrant;
    try {
      grant = await this.fetchRealtimeGrant();
    } catch (error) {
      if (generation !== this.realtimeGeneration) return;
      this.connecting = false;
      this.handleRealtimeGrantFailure(error);
      return;
    }
    if (generation !== this.realtimeGeneration || this.stopped) return;
    this.connecting = false;
    if (this.realtimeUnavailable) {
      this.realtimeUnavailable = false;
      logger.info('SYNC_CLIENT', 'Sync server now offers Realtime; live updates resuming');
    }
    try {
      const ws = new this.webSocketImpl!(grant.socketUrl);
      this.socket = ws;
      this.realtimeGrant = grant;
      this.realtimeRef = 0;
      this.joinRef = null;
      this.pendingHeartbeatRef = null;
      // Handlers compare against this.socket so events from a torn-down
      // socket (nulled first in teardownSocket) are inert.
      ws.onopen = () => this.handleSocketOpen(ws);
      ws.onmessage = (event) => this.handleSocketMessage(ws, event?.data);
      ws.onerror = () => { /* the close event always follows; handled there */ };
      ws.onclose = () => this.handleSocketClose(ws);
      const joinReplyTimer = setTimeout(() => {
        this.joinReplyTimer = null;
        if (ws !== this.socket || this.stopped) return;
        this.socketSelfHeal('Realtime join unanswered',
          new Error(`no phx_reply to the channel join within ${this.wsJoinReplyTimeoutMs} ms`), false);
      }, this.wsJoinReplyTimeoutMs);
      (joinReplyTimer as unknown as { unref?: () => void }).unref?.();
      this.joinReplyTimer = joinReplyTimer;
    } catch (error) {
      this.socketSelfHeal('Realtime connect failed', error, false);
    }
  }

  /** POST /v1/sync/realtime-token. Throws RealtimeTokenError on a non-2xx. */
  private async fetchRealtimeGrant(): Promise<RealtimeGrant> {
    const res = await this.fetchImpl(`${this.hubUrl}/v1/sync/realtime-token`, {
      method: 'POST',
      headers: this.hubHeaders(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new RealtimeTokenError(res.status, `sync realtime-token ${res.status}: ${body}`);
    }
    const json = await res.json() as Record<string, unknown> | null;
    const accessToken = json?.access_token;
    const expiresAt = json?.expires_at;
    const realtimeUrl = json?.realtime_url;
    const apikey = json?.apikey;
    const topic = json?.topic;
    if (
      typeof accessToken !== 'string' || accessToken === ''
      || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
      || typeof realtimeUrl !== 'string' || !/^wss?:\/\//i.test(realtimeUrl)
      || typeof apikey !== 'string' || apikey === ''
      || typeof topic !== 'string' || topic === ''
    ) {
      throw new Error('sync realtime-token: malformed response');
    }
    const socketUrl = new URL(realtimeUrl);
    socketUrl.searchParams.set('apikey', apikey);
    socketUrl.searchParams.set('vsn', '1.0.0');
    return {
      accessToken,
      expiresAtMs: expiresAt * 1000,
      socketUrl: socketUrl.toString(),
      channelTopic: `realtime:${topic}`,
    };
  }

  /** 404 ⇒ no Realtime (re-probe hourly); 401/403 ⇒ auth pause; else backoff. */
  private handleRealtimeGrantFailure(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const status = error instanceof RealtimeTokenError ? error.status : null;
    if (status === 404) {
      if (!this.realtimeUnavailable) {
        this.realtimeUnavailable = true;
        logger.info('SYNC_CLIENT', 'Sync server has no Realtime (realtime-token 404); staying on HTTP polling', {
          retryMs: this.realtimeUnavailableRetryMs,
        });
      }
      this.realtimeUnavailableUntil = this.now() + this.realtimeUnavailableRetryMs;
      this.scheduleReconnect(this.realtimeUnavailableRetryMs);
      return;
    }
    if (status === 401 || status === 403) {
      this.enterAuthPause(err);
      return;
    }
    logger.debug('SYNC_CLIENT', 'Realtime token fetch failed (live updates only; will retry with backoff)', {}, err);
    this.scheduleReconnect();
  }

  private nextRef(): string {
    this.realtimeRef++;
    return String(this.realtimeRef);
  }

  /** Throws when the socket refuses the frame — callers route that to self-heal. */
  private sendFrame(ws: SyncSocketLike, frame: PhoenixFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private handleSocketOpen(ws: SyncSocketLike): void {
    if (ws !== this.socket || this.stopped || !this.realtimeGrant) return;
    try {
      const joinRef = this.nextRef();
      this.joinRef = joinRef;
      this.sendFrame(ws, {
        topic: this.realtimeGrant.channelTopic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false, ack: false },
            presence: { enabled: false },
            private: true,
          },
          access_token: this.realtimeGrant.accessToken,
        },
        ref: joinRef,
        join_ref: joinRef,
      });
    } catch (error) {
      this.socketSelfHeal('Realtime join send failed', error, false);
      return;
    }
    // Liveness: each heartbeat must be answered before the next one goes out.
    const heartbeatTimer = setInterval(() => this.sendHeartbeat(ws), this.wsPingIntervalMs);
    (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
    this.heartbeatTimer = heartbeatTimer;
  }

  private sendHeartbeat(ws: SyncSocketLike): void {
    if (ws !== this.socket || this.stopped) return;
    if (this.pendingHeartbeatRef !== null) {
      this.socketSelfHeal('Realtime heartbeat unanswered',
        new Error(`heartbeat ref ${this.pendingHeartbeatRef} got no reply within ${this.wsPingIntervalMs} ms`), false);
      return;
    }
    try {
      const ref = this.nextRef();
      this.pendingHeartbeatRef = ref;
      this.sendFrame(ws, { topic: 'phoenix', event: 'heartbeat', payload: {}, ref });
    } catch (error) {
      this.socketSelfHeal('Realtime heartbeat send failed', error, false);
    }
  }

  private handleSocketClose(ws: SyncSocketLike): void {
    if (ws !== this.socket) return;
    this.teardownSocket();
    this.setSocketLive(false); // restores normal poll cadence
    if (!this.stopped) this.scheduleReconnect();
  }

  /**
   * Phoenix frames. Our channel's join reply flips the socket live and runs
   * one catch-up pull; `advance` broadcasts trigger the HTTP pull path; a
   * join/channel error drops the socket and reconnects with backoff; an
   * epoch mismatch or a malformed frame additionally pulls once over HTTP.
   */
  private handleSocketMessage(ws: SyncSocketLike, data: unknown): void {
    if (ws !== this.socket || this.stopped || !this.realtimeGrant) return;
    let frame: PhoenixFrame;
    try {
      if (typeof data !== 'string') throw new Error('non-text Realtime frame');
      frame = JSON.parse(data) as PhoenixFrame;
      if (frame === null || typeof frame !== 'object') throw new Error('Realtime frame is not an object');
    } catch (error) {
      this.socketSelfHeal('Realtime frame anomaly', error, true);
      return;
    }
    const payload = (frame.payload ?? null) as Record<string, unknown> | null;

    if (frame.topic === 'phoenix') {
      if (frame.event === 'phx_reply' && frame.ref === this.pendingHeartbeatRef) {
        this.pendingHeartbeatRef = null;
      }
      return;
    }
    if (frame.topic !== this.realtimeGrant.channelTopic) return; // not ours

    switch (frame.event) {
      case 'phx_reply': {
        if (frame.ref === this.joinRef) {
          this.clearJoinReplyTimer();
          if (payload?.status !== 'ok') {
            this.socketSelfHeal('Realtime join refused',
              new Error(`join reply: ${JSON.stringify(payload?.response ?? payload)}`), false);
            return;
          }
          this.wsAttempts = 0;
          this.scheduleTokenRefresh(this.realtimeGrant);
          this.setSocketLive(true);
          // Broadcasts sent while we were disconnected are gone (advisory
          // lane): close the gap over HTTP the moment the fast path is up.
          this.pullForSocket();
          return;
        }
        if (payload?.status === 'error') {
          this.socketSelfHeal('Realtime request refused',
            new Error(`reply to ref ${String(frame.ref)}: ${JSON.stringify(payload.response ?? payload)}`), false);
        }
        return;
      }
      case 'system': {
        // e.g. {status:'error', message:'Token has expired'}
        if (payload?.status === 'error') {
          this.socketSelfHeal('Realtime system error', new Error(String(payload.message ?? 'unknown')), false);
        }
        return;
      }
      case 'phx_error':
      case 'phx_close':
        this.socketSelfHeal(`Realtime ${frame.event}`, new Error(`channel ${frame.event}`), false);
        return;
      case 'broadcast':
        try {
          this.handleBroadcast(payload);
        } catch (error) {
          this.socketSelfHeal('Realtime advance anomaly', error, true);
        }
        return;
      default:
        return; // presence etc. — not used, never an anomaly
    }
  }

  /** Throws on any anomaly — the caller routes that into socketSelfHeal (with an HTTP pull). */
  private handleBroadcast(broadcast: Record<string, unknown> | null): void {
    if (broadcast?.event !== 'advance') return;
    const advance = broadcast.payload as { epoch?: unknown; head_seq?: unknown } | null;
    if (typeof advance?.epoch !== 'string' || typeof advance.head_seq !== 'string') {
      throw new Error('advance broadcast requires decimal-string epoch and head_seq');
    }
    // Epoch check FIRST, before the caught-up short-circuit: a rebuilt log
    // restarts seqs low, so its head would otherwise look "already seen".
    // The self-heal's HTTP pull runs handleEpoch (cursor reset + requeue).
    assertCanonicalDecimal(advance.epoch);
    const storedEpoch = this.apply.getEpoch();
    if (storedEpoch !== null && storedEpoch !== advance.epoch) {
      throw new Error(`sync epoch changed on the live channel (${storedEpoch} -> ${advance.epoch})`);
    }
    const head = assertCanonicalDecimal(advance.head_seq);
    if (compareCanonicalDecimals(head, this.apply.getCursor()) <= 0) return; // a pull raced it
    this.pullForSocket();
  }

  /** Re-mint the access token at ~80 % of its lifetime and hand it to the open channel. */
  private scheduleTokenRefresh(grant: RealtimeGrant): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const delay = Math.max(1_000, (grant.expiresAtMs - this.now()) * 0.8);
    const generation = this.realtimeGeneration;
    const timer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      void this.refreshRealtimeToken(generation);
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tokenRefreshTimer = timer;
  }

  private async refreshRealtimeToken(generation: number): Promise<void> {
    let grant: RealtimeGrant;
    try {
      grant = await this.fetchRealtimeGrant();
    } catch (error) {
      if (generation !== this.realtimeGeneration || this.stopped) return;
      this.teardownSocket();
      this.setSocketLive(false);
      this.handleRealtimeGrantFailure(error);
      return;
    }
    const ws = this.socket;
    if (generation !== this.realtimeGeneration || this.stopped || !ws || !this.realtimeGrant) return;
    this.realtimeGrant = { ...this.realtimeGrant, accessToken: grant.accessToken, expiresAtMs: grant.expiresAtMs };
    try {
      this.sendFrame(ws, {
        topic: this.realtimeGrant.channelTopic,
        event: 'access_token',
        payload: { access_token: grant.accessToken },
        ref: this.nextRef(),
        join_ref: this.joinRef,
      });
    } catch (error) {
      this.socketSelfHeal('Realtime token refresh send failed', error, false);
      return;
    }
    this.scheduleTokenRefresh(this.realtimeGrant);
  }

  /** Close the socket, optionally pull once over HTTP, reconnect with backoff. */
  private socketSelfHeal(context: string, error: unknown, catchUpOverHttp: boolean): void {
    try {
      try {
        logger.debug('SYNC_CLIENT', `Realtime self-heal (${context}): closing socket`, { catchUpOverHttp },
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* logging must never block the heal */ }
      this.teardownSocket();
      this.setSocketLive(false);
      if (!this.stopped) {
        if (catchUpOverHttp) this.pullForSocket(); // HTTP is the truth
        this.scheduleReconnect();
      }
    } catch { /* advisory: never propagate */ }
  }

  /** Socket recovery skips the min-gap, but honors a transient HTTP failure. */
  private pullForSocket(): void {
    if (this.stopped) return;
    const remaining = this.transientRetryAt - this.now();
    if (remaining > 0) {
      this.schedule(remaining);
      return;
    }
    void this.pullOnce({ force: true });
  }

  /**
   * Default delay: full-jitter backoff random(0, min(cap, base·2^attempt)).
   * An explicit delay (the hourly no-Realtime re-probe) skips the ladder.
   */
  private scheduleReconnect(delayMs?: number): void {
    if (!this.wsEnabled || this.stopped || this.reconnectTimer || this.socket || this.connecting) return;
    if (this.authPausedUntil > this.now()) return;
    let delay = delayMs;
    if (delay === undefined) {
      const exp = Math.min(this.wsAttempts, 30); // clamp 2^n against overflow
      const ceiling = Math.min(this.wsBackoffMaxMs, this.wsBackoffBaseMs * 2 ** exp);
      delay = this.random() * ceiling;
      this.wsAttempts++;
    }
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      if (delayMs !== undefined) this.realtimeUnavailableUntil = 0; // re-probe is due
      try {
        this.connectSocket();
      } catch { /* connectSocket guards itself; belt only */ }
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.reconnectTimer = timer;
  }

  private clearJoinReplyTimer(): void {
    if (this.joinReplyTimer) {
      clearTimeout(this.joinReplyTimer);
      this.joinReplyTimer = null;
    }
  }

  private teardownSocket(): void {
    this.realtimeGeneration++; // in-flight token fetches become inert
    this.connecting = false;
    this.clearJoinReplyTimer();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.pendingHeartbeatRef = null;
    this.joinRef = null;
    this.realtimeGrant = null;
    const ws = this.socket;
    this.socket = null; // null FIRST: our own close() event must be inert
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      try {
        ws.terminate?.();
      } catch { /* already dead — exactly what we wanted */ }
    }
  }

  /**
   * Liveness transitions: notify CloudSync (fast-debounce coupling) and
   * re-schedule a pending poll timer onto the new cadence — connect stretches
   * an active 30 s tick out to the idle tier; disconnect restores it.
   */
  private setSocketLive(live: boolean): void {
    if (this.socketLive === live) return;
    this.socketLive = live;
    if (this.onSocketLiveChange) {
      try {
        this.onSocketLiveChange(live);
      } catch (error) {
        try {
          logger.debug('SYNC_CLIENT', 'onSocketLiveChange listener threw (ignored)', {},
            error instanceof Error ? error : new Error(String(error)));
        } catch { /* never propagate */ }
      }
    }
    if (this.started && !this.stopped && this.timer !== null) {
      const delay = this.currentDelay();
      if (delay !== null) this.schedule(delay);
      // delay === null ⇒ suspended; leave suspension to its existing owners.
    }
  }

  /**
   * Failure bookkeeping: back off (doubling), and when the SAME page keeps
   * failing — e.g. a malformed op that applyOps refuses, leaving the cursor
   * unmoved — log distinctly so the wedge is visible in the logs.
   */
  private recordFailure(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    let cursor: string | null = null;
    try {
      cursor = this.apply.getCursor();
    } catch { /* DB may be closing — cursor stays null */ }
    if (cursor === this.failCursor) {
      this.failStreak++;
    } else {
      this.failCursor = cursor;
      this.failStreak = 1;
    }
    if (/^sync hub pull 40[13]:/.test(err.message)) {
      this.enterAuthPause(err);
      return;
    }
    this.backoffMs = this.backoffMs === 0
      ? this.backoffInitialMs
      : Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.transientRetryAt = this.now() + this.backoffMs;
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

  /**
   * 401/403 (from a pull or the realtime-token mint): retrying on the normal
   * ladder cannot succeed (#4231-class storm). Hold pulls and Realtime for the
   * auth pause; CloudSync owns the user-facing status for this cause.
   */
  private enterAuthPause(err: Error): void {
    const firstPause = this.authPausedUntil === 0;
    this.backoffMs = Math.max(this.backoffMs, this.authPauseMs);
    this.authPausedUntil = this.now() + this.authPauseMs;
    if (this.socket || this.connecting) {
      this.teardownSocket();
      this.setSocketLive(false);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (firstPause) {
      logger.warn('SYNC_CLIENT', 'Rejected by the sync server (auth); pausing pulls and live updates', {
        pauseMs: this.authPauseMs,
      }, err);
    }
  }
}
