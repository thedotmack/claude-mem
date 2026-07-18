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
// FAILURE CONTRACT (same swallow-and-log posture as CloudSync.notify()):
// nothing here ever throws into a caller, blocks a write, or crashes the
// worker. Failures back off (30 s doubling to 10 min, dominating the poll
// tier) and repeated failure of the SAME page logs distinctly (wedge
// visibility) — no dead-letter machinery this phase. NO long-polling (prime
// directive #4): every request is a plain short GET with an AbortSignal
// timeout.

import { logger } from '../../utils/logger.js';
import type { SyncApply, SyncOp } from './SyncApply.js';

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
  private failCursor = -1;

  // Advisory socket state (all of it disposable — prime directive #2).
  private socket: SyncSocketLike | null = null;
  private socketLive = false;
  private wsAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!this.wsEnabled || this.stopped || this.socket || !this.webSocketImpl) return;
    try {
      const ws = new this.webSocketImpl(this.wsUrl, {
        // Bun extension: headers on the constructor (plan Phase 0.3) — the
        // exact credential trio the HTTP lanes send.
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-User-Id': this.userId,
          'X-Device-Id': this.deviceId,
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
        const head = frame.head_seq;
        if (typeof head === 'number' && Number.isFinite(head) && head <= this.apply.getCursor()) {
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
    const seqs = ops.map((op) => (op as { seq?: unknown }).seq);
    for (const seq of seqs) {
      if (typeof seq !== 'number' || !Number.isFinite(seq)) {
        throw new Error('op frame with a malformed seq');
      }
    }
    for (let i = 1; i < seqs.length; i++) {
      if ((seqs[i] as number) !== (seqs[i - 1] as number) + 1) {
        throw new Error('op frame is not internally contiguous');
      }
    }
    const cursor = this.apply.getCursor();
    const first = seqs[0] as number;
    const last = seqs[seqs.length - 1] as number;
    if (last <= cursor) {
      // Fully-stale frame: an HTTP pull already applied all of it. This is
      // the normal pull/fan-out race, not an anomaly — applying would be a
      // pure no-op, so skip without churning the socket.
      return;
    }
    if (first > cursor + 1) {
      throw new Error(`op frame gap: frame starts at seq ${first}, cursor is ${cursor}`);
    }
    // first <= cursor+1 <= last: contiguous with the cursor (any stale prefix
    // is skipped inside applyOps via its own cursor guard). A rebuilt hub was
    // already caught by the frame-level epoch check in handleSocketMessage;
    // passing the epoch through applyOps keeps first-contact adoption and a
    // last-resort reset identical to the HTTP lane.
    const result = this.apply.applyOps(ops as SyncOp[], {
      epoch: typeof frame.epoch === 'string' ? frame.epoch : undefined,
    });
    if (result.epochReset) {
      // Backstop (frame carried no epoch string, or a race): cursor is back
      // at 0 and the frame was discarded — re-bootstrap over HTTP.
      throw new Error('hub epoch changed mid-socket');
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
    if (!this.wsEnabled || this.stopped || this.reconnectTimer || this.socket) return;
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
