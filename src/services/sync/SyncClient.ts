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
//     all, and the advisory socket is torn down with it (an idle client
//     needs no speed layer, and a held socket would both pin the hub DO
//     and be unreachable by kill-switch headers). pullOnce() (the
//     session-start pull) and onHeadSeq() (the push piggyback) both resume
//     the loop AND reconnect the socket, so a suspended worker wakes the
//     moment anything happens.
// Every push response piggybacks head_seq (CloudSync.setHeadSeqListener →
// onHeadSeq): head_seq > cursor triggers an immediate pull without waiting
// for the timer — the free poll for the active device.
//
// ADVISORY WEBSOCKET (plan Phase 4 task 2 — the speed layer): when enabled
// (CLAUDE_MEM_CLOUD_SYNC_WS, default on) the client also holds one Bun-native
// WebSocket to {hub}/v1/sync/ws (Bun extension: auth headers ride the
// constructor — no ws npm package). The socket is STRICTLY advisory (prime
// directive #2): nothing durable rides it. A {type:'op'} frame whose ops are
// contiguous with the cursor feeds the SAME SyncApply.applyOps path as HTTP
// pulls (cursor advances transactionally as usual); ANY anomaly — gap, parse
// error, unknown frame, epoch mismatch, apply throw — closes the socket and
// runs one HTTP pullOnce() (the lane-2 self-heal). {type:'advance'} frames
// just trigger pullOnce(). The cursor is NEVER written outside SyncApply.
// Keepalive is a protocol-level ws.ping() every ~40 s (the hub runtime
// auto-pongs without waking the DO); reconnects use full-jitter backoff
// (1 s base, 60 s cap). While the socket is CONNECTED the active poll tier
// stretches to the idle tier (the socket is the fast path; polling is the
// safety net); a disconnect restores normal cadence. Total failure of every
// socket code path leaves Phase 3 (HTTP-only) behavior intact — delete the
// socket and this class still converges.
//
// KILL-SWITCH POLL MODE (plan Phase 5 task 2): while the hub's kill switch
// is tripped, every HTTP sync response carries `X-Sync-Mode: poll`. This
// client reads the header on its own pull responses (pullCycle) and receives
// the push-surface hints from CloudSync via onSyncModeHint (the head_seq
// piggyback shape). On 'poll': close the socket, suppress reconnects, keep
// polling — which is ALSO the re-probe: the mode holds exactly until the
// header disappears from a subsequent response, then the socket resumes.
// No extra endpoint, no extra timer; poll mode is plain Phase 3 behavior,
// which is the structural guarantee (the product stays complete).
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
import {
  assertCanonicalDecimal,
  canonicalDecimalToSafeInteger,
  canonicalJson,
  compareCanonicalDecimals,
  decodeHubChange,
  incrementCanonicalDecimal,
  type CanonicalHubChange,
} from './CanonicalContent.js';

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

function decodeChanges(values: unknown[]): SyncOp[] {
  return values.map(value => {
    const decoded = decodeHubChange(value as CanonicalHubChange);
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
 * WebSocket (including its ping()/terminate() extensions) and by test mocks.
 * Injectable via SyncClientOptions.webSocketImpl (the fetchImpl idiom).
 */
export interface SyncSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
  /** Bun extension: protocol-level ping (auto-ponged by the hub runtime). */
  ping?(): void;
  /** Bun extension: hard-drop without a close handshake. */
  terminate?(): void;
}

export type SyncWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> }
) => SyncSocketLike;

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
   * Advisory WebSocket gate (CLAUDE_MEM_CLOUD_SYNC_WS ≠ 'false'). Defaults to
   * enabled; forced off when no WebSocket implementation is available. The
   * socket is strictly optional — disabled ⇒ exact Phase 3 behavior.
   */
  wsEnabled?: boolean;
  /** Injectable WebSocket constructor (tests). Defaults to Bun's global. */
  webSocketImpl?: SyncWebSocketConstructor;
  /** Protocol-level keepalive ping cadence (~40 s). */
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
  private readonly minPullGapMs: number;
  private readonly isSessionActive: (() => boolean) | null;
  private readonly now: () => number;

  private readonly wsEnabled: boolean;
  private readonly webSocketImpl: SyncWebSocketConstructor | null;
  private readonly wsUrl: string;
  private readonly wsPingIntervalMs: number;
  private readonly wsBackoffBaseMs: number;
  private readonly wsBackoffMaxMs: number;
  private readonly onSocketLiveChange: ((live: boolean) => void) | null;
  private readonly random: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private pulling = false;
  private lastActiveAt = 0;
  private lastPullFinishedAt = 0;
  /** 0 = healthy; doubles per consecutive failed cycle. */
  private backoffMs = 0;
  private failStreak = 0;
  private failCursor: string | null = null;

  // Advisory socket state (all of it disposable — prime directive #2).
  private socket: SyncSocketLike | null = null;
  private socketLive = false;
  private wsAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the hub says X-Sync-Mode: poll (kill switch tripped). */
  private pollModeOnly = false;
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
    this.minPullGapMs = options.minPullGapMs ?? 2_000;
    this.isSessionActive = options.isSessionActive ?? null;
    this.now = options.now ?? Date.now;

    // Advisory socket config. The gate: setting-enabled AND an implementation
    // exists (Bun's global WebSocket, or an injected test double). No
    // implementation ⇒ silently HTTP-only — never a construction failure.
    this.webSocketImpl = options.webSocketImpl
      ?? ((globalThis as { WebSocket?: unknown }).WebSocket as SyncWebSocketConstructor | undefined)
      ?? null;
    this.wsEnabled = (options.wsEnabled ?? true) && this.webSocketImpl !== null;
    // http→ws / https→wss, same host and port as the HTTP lanes.
    this.wsUrl = `${this.hubUrl.replace(/^http/i, 'ws')}/v1/sync/ws`;
    this.wsPingIntervalMs = options.wsPingIntervalMs ?? 40_000;
    this.wsBackoffBaseMs = options.wsBackoffBaseMs ?? 1_000;
    this.wsBackoffMaxMs = options.wsBackoffMaxMs ?? 60_000;
    this.onSocketLiveChange = options.onSocketLiveChange ?? null;
    this.random = options.random ?? Math.random;
  }

  /** Kick an immediate catch-up pull, then run the cadence loop. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastActiveAt = this.now(); // boot grace: idle tier, not insta-suspend
    this.schedule(0);
    // Advisory socket, fully firewalled: a throwing connect path must never
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
   * Sync-mode hint (plan Phase 5 task 2). Sources: this class's own pull
   * responses (pullCycle) and CloudSync's push responses
   * (setSyncModeListener wiring in the worker). 'poll' ⇒ enter poll-only
   * mode (socket closed, reconnects suppressed, HTTP polling untouched);
   * anything else — including null for a missing header — ⇒ leave it and
   * resume the socket. CONTRACT for callers: only report null (header
   * absent) from an OK response — absence on an error response is
   * ambiguous and must be suppressed at the source (both call sites do).
   * Idempotent per state, and never throws (called from the flush path).
   */
  onSyncModeHint(mode: string | null): void {
    try {
      if (this.stopped) return;
      if (mode === 'poll') {
        this.enterPollMode();
      } else {
        this.exitPollMode();
      }
    } catch (error) {
      try {
        logger.debug('SYNC_CLIENT', 'onSyncModeHint failed (non-blocking)', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* never propagate */ }
    }
  }

  /** True while honoring X-Sync-Mode: poll (test/status introspection). */
  isPollModeOnly(): boolean {
    return this.pollModeOnly;
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
      const head = assertCanonicalDecimal(headSeq);
      if (compareCanonicalDecimals(head, this.apply.getCursor()) <= 0) return;
      this.resumeIfSuspended(); // socket back up alongside the loop
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
   *
   * `force` (socket paths only — self-heal, reconnect catch-up, advance
   * frames) bypasses the min-gap skip: those pulls are the correctness net
   * for a lane that just failed or reconnected, and with the socket live the
   * poll tier is stretched, so "wait for the next poll" could mean minutes.
   * Single-flight still holds either way.
   */
  async pullOnce(options: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
    try {
      if (this.stopped) return;
      this.lastActiveAt = this.now();
      this.resumeIfSuspended(); // session activity: socket back up too
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const skip =
        this.pulling || // a cycle is already fetching — don't stack a second
        (!options.force && this.now() - this.lastPullFinishedAt < this.minPullGapMs);
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
      // Suspended: no timer AND no socket. An idle client needs no speed
      // layer, and a held socket would be the one thing keeping the hub DO
      // from hibernating — while ALSO never seeing a stamped HTTP response,
      // so a kill-switch trip could never reach it (the exact
      // hibernation-defeat case the watchdog's auto-trip exists for).
      // pullOnce()/onHeadSeq() re-arm the loop and reconnect the socket.
      this.suspended = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.teardownSocket();
      this.setSocketLive(false);
      logger.debug('SYNC_CLIENT', 'Pull loop suspended (no session activity for over an hour) — advisory socket closed');
      return;
    }
    this.schedule(delay);
  }

  /**
   * Leaving suspension (session activity, a session-start pull, or a push
   * piggyback): re-open the advisory socket the suspend branch tore down.
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
              ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
            },
            // Plain short request — never a held connection (directive #4).
            signal: AbortSignal.timeout(Math.max(1, Math.min(this.requestTimeoutMs, remaining))),
          }
        );
        // Kill-switch mode hint (plan Phase 5 task 2), read BEFORE the
        // ok-check — the header rides error responses too. Asymmetric on
        // purpose: header PRESENCE means poll regardless of status, but
        // header ABSENCE only means "cleared" on an OK response. An error
        // response without the header (a degraded auth upstream 503ing
        // everything mid-incident — incidents correlate) is ambiguous and
        // must not exit poll mode, or the client would resume socket
        // churn for the whole outage.
        const syncMode = res.headers.get('X-Sync-Mode');
        if (syncMode !== null || res.ok) {
          this.onSyncModeHint(syncMode);
        }
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
  // Advisory WebSocket (plan Phase 4 task 2)
  //
  // Everything below is disposable: any failure tears the socket down, runs
  // at most one HTTP pullOnce(), and schedules a jittered reconnect. The HTTP
  // lanes never depend on any of it.
  // -------------------------------------------------------------------------

  /** True while the advisory socket is open (test/status introspection). */
  isSocketLive(): boolean {
    return this.socketLive;
  }

  private connectSocket(): void {
    // pollModeOnly gate: while the hub says poll, the socket lane stays
    // down — that is the kill switch doing its job (un-pinning hub DOs).
    if (!this.wsEnabled || this.stopped || this.socket || !this.webSocketImpl || this.pollModeOnly) return;
    try {
      const ws = new this.webSocketImpl(this.wsUrl, {
        // Bun extension: headers on the constructor (plan Phase 0.3) — the
        // exact credential trio the HTTP lanes send.
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-User-Id': this.userId,
          'X-Device-Id': this.deviceId,
          ...(this.deviceName ? { 'X-Device-Name': this.deviceName } : {}),
        },
      });
      this.socket = ws;
      // Handlers compare against this.socket so events from a torn-down
      // socket (nulled first in teardownSocket) are inert.
      ws.onopen = () => this.handleSocketOpen(ws);
      ws.onmessage = (event) => this.handleSocketMessage(ws, event?.data);
      ws.onerror = () => { /* the close event always follows; handled there */ };
      ws.onclose = () => this.handleSocketClose(ws);
    } catch (error) {
      // Connect failures are silent-but-logged (advisory — polling continues).
      this.socket = null;
      try {
        logger.debug('SYNC_CLIENT', 'Socket connect failed (advisory; will retry with backoff)', {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* never propagate */ }
      this.scheduleReconnect();
    }
  }

  private handleSocketOpen(ws: SyncSocketLike): void {
    if (ws !== this.socket || this.stopped) return;
    this.wsAttempts = 0;
    this.setSocketLive(true);
    // Keepalive: protocol-level ping (Bun ws.ping()); the hub runtime
    // auto-pongs without waking the DO. Guarded — a ping on a dying socket
    // must never throw into the timer.
    const pingTimer = setInterval(() => {
      try {
        this.socket?.ping?.();
      } catch { /* the close handler owns recovery */ }
    }, this.wsPingIntervalMs);
    (pingTimer as unknown as { unref?: () => void }).unref?.();
    this.pingTimer = pingTimer;
    // Catch up over HTTP once: frames sent while we were disconnected are
    // gone (advisory lane), so close the gap the moment the fast path is up.
    void this.pullOnce({ force: true });
  }

  private handleSocketClose(ws: SyncSocketLike): void {
    if (ws !== this.socket) return;
    this.teardownSocket();
    this.setSocketLive(false); // restores normal poll cadence
    if (!this.stopped) this.scheduleReconnect();
  }

  /**
   * Advisory protocol (plan Phase 4 task 2). op frames contiguous with the
   * cursor apply through SyncApply (the SAME path as HTTP pulls — the cursor
   * is never written here); advance frames trigger a pull; EVERYTHING else —
   * gap, parse error, unknown type, epoch mismatch, apply throw — is an
   * anomaly: close the socket and run one HTTP pullOnce() (lane-2 self-heal).
   */
  private handleSocketMessage(ws: SyncSocketLike, data: unknown): void {
    if (ws !== this.socket || this.stopped) return;
    try {
      if (typeof data !== 'string') {
        throw new Error('non-text socket frame');
      }
      const frame = JSON.parse(data) as {
        type?: unknown; epoch?: unknown; ops?: unknown; head_seq?: unknown;
      };
      // Epoch check FIRST, before any stale/caught-up short-circuit: a
      // rebuilt hub restarts seqs low, so its frames would otherwise look
      // "fully stale" here and detection would defer to the (stretched)
      // poll. A mismatch is an anomaly — the self-heal's HTTP pull runs
      // handleEpoch, which owns the cursor reset + native-corpus requeue.
      if (typeof frame.epoch === 'string') {
        assertCanonicalDecimal(frame.epoch);
        const storedEpoch = this.apply.getEpoch();
        if (storedEpoch !== null && storedEpoch !== frame.epoch) {
          throw new Error(`hub epoch changed on the socket (${storedEpoch} -> ${frame.epoch})`);
        }
      }
      if (frame.type === 'op') {
        this.handleOpFrame(frame);
        return;
      }
      if (frame.type === 'advance') {
        if (typeof frame.head_seq !== 'string') {
          throw new Error('advance frame requires decimal-string head_seq');
        }
        const head = assertCanonicalDecimal(frame.head_seq);
        if (compareCanonicalDecimals(head, this.apply.getCursor()) <= 0) {
          return; // already caught up (an HTTP pull raced the frame)
        }
        void this.pullOnce({ force: true });
        return;
      }
      throw new Error(`unknown socket frame type: ${String(frame.type)}`);
    } catch (error) {
      this.socketSelfHeal('socket frame anomaly', error);
    }
  }

  /** Throws on any anomaly — the caller routes that into socketSelfHeal. */
  private handleOpFrame(frame: { epoch?: unknown; ops?: unknown }): void {
    const ops = frame.ops;
    if (!Array.isArray(ops)) {
      throw new Error('op frame without an ops array');
    }
    if (ops.length === 0) return; // vacuous frame — nothing to do
    const decodedOps = decodeChanges(ops);
    const seqs = decodedOps.map(op => op.seq);
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] !== incrementCanonicalDecimal(seqs[i - 1]!)) {
        throw new Error('op frame is not internally contiguous');
      }
    }
    const cursor = this.apply.getCursor();
    const first = seqs[0]!;
    const last = seqs[seqs.length - 1]!;
    if (compareCanonicalDecimals(last, cursor) <= 0) {
      // Fully-stale frame: an HTTP pull already applied all of it. This is
      // the normal pull/fan-out race, not an anomaly — applying would be a
      // pure no-op, so skip without churning the socket.
      return;
    }
    if (compareCanonicalDecimals(first, incrementCanonicalDecimal(cursor)) > 0) {
      throw new Error(`op frame gap: frame starts at seq ${first}, cursor is ${cursor}`);
    }
    // first <= cursor+1 <= last: contiguous with the cursor (any stale prefix
    // is skipped inside applyOps via its own cursor guard). A rebuilt hub was
    // already caught by the frame-level epoch check in handleSocketMessage;
    // passing the epoch through applyOps keeps first-contact adoption and a
    // last-resort reset identical to the HTTP lane.
    const result = this.apply.applyOps(decodedOps, {
      epoch: typeof frame.epoch === 'string' ? frame.epoch : undefined,
    });
    if (result.epochReset) {
      // Backstop (frame carried no epoch string, or a race): cursor is back
      // at 0 and the frame was discarded — re-bootstrap over HTTP.
      throw new Error('hub epoch changed mid-socket');
    }
  }

  /**
   * Enter kill-switch poll mode: close the socket, cancel and suppress
   * reconnects. HTTP polling is deliberately untouched — it both keeps the
   * product complete AND acts as the re-probe (every pull response
   * re-evaluates the header). Idempotent.
   */
  private enterPollMode(): void {
    if (this.pollModeOnly) return;
    this.pollModeOnly = true;
    const hadSocket = this.socket !== null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.setSocketLive(false); // restores normal poll cadence + slow debounce
    logger.info('SYNC_CLIENT', 'Hub is in poll mode (X-Sync-Mode: poll) — socket closed, reconnects suppressed, HTTP sync continues', {
      hadSocket,
    });
  }

  /**
   * The header disappeared: hub left poll mode. Resume the socket with a
   * fresh backoff ladder. Idempotent.
   */
  private exitPollMode(): void {
    if (!this.pollModeOnly) return;
    this.pollModeOnly = false;
    this.wsAttempts = 0;
    logger.info('SYNC_CLIENT', 'Hub left poll mode — resuming the advisory socket');
    if (this.started && !this.stopped) {
      this.connectSocket();
    }
  }

  /** Close the socket, pull once over HTTP, reconnect with backoff. */
  private socketSelfHeal(context: string, error: unknown): void {
    try {
      try {
        logger.debug('SYNC_CLIENT', `Advisory socket self-heal (${context}): closing socket, catching up over HTTP`, {},
          error instanceof Error ? error : new Error(String(error)));
      } catch { /* logging must never block the heal */ }
      this.teardownSocket();
      this.setSocketLive(false);
      if (!this.stopped) {
        void this.pullOnce({ force: true }); // the lane-2 self-heal — HTTP is the truth
        this.scheduleReconnect();
      }
    } catch { /* advisory: never propagate */ }
  }

  /** Full-jitter backoff: delay = random(0, min(cap, base·2^attempt)). */
  private scheduleReconnect(): void {
    if (!this.wsEnabled || this.stopped || this.reconnectTimer || this.socket || this.pollModeOnly) return;
    const exp = Math.min(this.wsAttempts, 30); // clamp 2^n against overflow
    const ceiling = Math.min(this.wsBackoffMaxMs, this.wsBackoffBaseMs * 2 ** exp);
    const delay = this.random() * ceiling;
    this.wsAttempts++;
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.connectSocket();
      } catch { /* connectSocket guards itself; belt only */ }
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.reconnectTimer = timer;
  }

  private teardownSocket(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
