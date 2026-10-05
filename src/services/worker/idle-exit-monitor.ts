/**
 * Opt-in idle exit (CLAUDE_MEM_IDLE_EXIT_SEC): after the window elapses with
 * no session activity, no queued work, no host traffic and no AI
 * interaction, the worker shuts itself down through the same graceful
 * sequence as `claude-mem stop` (reason 'idle').
 *
 * Own module for the same reason as worker-shutdown.ts: worker-service.ts
 * drags in a very large dependency graph (isMainModule bootstrap,
 * bun:sqlite, MCP SDK, telemetry), so the monitor lives here with injected
 * dependencies and `bun test` can exercise the idle decision logic directly.
 *
 * Activity clock: lastActivityAt arms at start() — the worker arms the
 * monitor at the END of background init, so boot can never race the window —
 * and refreshes on every tick that observes activity. Timestamps observed
 * after the last tick (a finished AI interaction, a request that landed since
 * the previous check) also refresh the clock, so the window measures
 * "nothing at all has happened recently", not "nothing was visible at the
 * instant of the last tick". A failing observation refreshes the clock: never
 * exit on an inability to observe.
 *
 * Every signal is SYNCHRONOUS on purpose. The worker is the only caller, and
 * an awaited dependency that fails to settle would latch the tick guard and
 * silently disable the monitor forever — the failure mode is invisible, and
 * every backing signal here is in-memory anyway (SessionManager's session
 * map and message buffer, the Server's request stamp, a recorded timestamp).
 */

import { logger } from '../../utils/logger.js';

export interface IdleExitMonitorDeps {
  /** Idle window in milliseconds; 0 disables the monitor. */
  idleExitMs: number;
  /**
   * True when any in-memory session saw message/generator activity at or
   * after the cutoff (SessionManager.hasSessionActivitySince). Deliberately
   * NOT a session count: a session that merely exists is not activity — a
   * standing memory seat registered at boot, or a session idling between
   * prompts, would otherwise pin the worker awake forever.
   */
  hasSessionActivitySince: (cutoffMs: number) => boolean;
  /** Queued/pending work depth (SessionManager.getTotalQueueDepth). */
  getQueueDepth: () => number;
  /**
   * When a host last sent this worker a request (epoch ms), or null if never
   * (Server.getLastRequestAt).
   *
   * A timestamp, NOT an open-socket count: socket lifecycle is unreliable
   * across runtimes (see Server.getLastRequestAt), and a long-lived client
   * refreshes a timestamp exactly like it refreshes a socket count.
   */
  getLastRequestAt: () => number | null;
  /** Timestamp (epoch ms) of the last completed AI interaction, or null if none yet. */
  getLastAiInteractionAt: () => number | null;
  /** Fired once when the idle window elapses; the caller runs the graceful shutdown. */
  onIdle: (idleMs: number) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Tick cadence in ms (default 30 s). The interval is unref'd so the monitor never holds the event loop open. */
  tickIntervalMs?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;

export class IdleExitMonitor {
  private readonly deps: IdleExitMonitorDeps & { now: () => number; tickIntervalMs: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;

  constructor(deps: IdleExitMonitorDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      tickIntervalMs: deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    // Disabled (CLAUDE_MEM_IDLE_EXIT_SEC=0) never arms; the worker's wiring
    // also never constructs the monitor for 0, so this is belt-and-suspenders.
    if (this.deps.idleExitMs <= 0) return;
    if (this.timer !== null) return;
    this.lastActivityAt = this.deps.now();
    this.timer = setInterval(() => { this.tick(); }, this.deps.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One idle check, exposed so tests can drive the decision logic without
   * real timers. Synchronous, so interval ticks can never overlap.
   */
  tick(): void {
    if (this.timer === null) return;
    this.checkIdle();
  }

  private checkIdle(): void {
    const now = this.deps.now();

    // Events that landed since the last tick are activity even if this tick
    // would otherwise see an idle worker: the window must measure "nothing
    // happened recently", not "nothing was true at the instant of the tick".
    const lastRequestAt = this.deps.getLastRequestAt();
    if (lastRequestAt !== null && lastRequestAt > this.lastActivityAt) {
      this.lastActivityAt = lastRequestAt;
    }
    const lastAiAt = this.deps.getLastAiInteractionAt();
    if (lastAiAt !== null && lastAiAt > this.lastActivityAt) {
      this.lastActivityAt = lastAiAt;
    }

    let sessionActivity: boolean;
    let queueDepth: number;
    try {
      sessionActivity = this.deps.hasSessionActivitySince(now - this.deps.idleExitMs);
      queueDepth = this.deps.getQueueDepth();
    } catch (error: unknown) {
      // Never exit on an observation failure — refresh the clock instead.
      this.lastActivityAt = now;
      logger.warn('SYSTEM', 'Idle-exit activity read failed — treating as activity', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const idleMs = now - this.lastActivityAt;

    // Logged on EVERY tick, busy or not: "why isn't my worker exiting?" is
    // the first question this feature will ever be asked, and the answer has
    // to be in the log.
    logger.info('SYSTEM', 'Idle-exit check', {
      idleMs,
      idleExitMs: this.deps.idleExitMs,
      sessionActivity,
      queueDepth,
      lastRequestAt,
      lastAiAt,
    });

    if (sessionActivity || queueDepth > 0) {
      this.lastActivityAt = now;
      return;
    }

    if (idleMs < this.deps.idleExitMs) return;

    // Disarm first so the drain (or any late tick) cannot re-fire onIdle.
    this.stop();
    logger.info('SYSTEM', 'Idle window elapsed — no session activity, queued work, client connections or AI interactions — initiating idle shutdown', {
      idleMs,
      idleExitMs: this.deps.idleExitMs,
    });
    this.deps.onIdle(idleMs);
  }
}

/**
 * Parse CLAUDE_MEM_IDLE_EXIT_SEC. Returns milliseconds for a valid value, 0
 * for an absent/empty value (the seeded default '0' means "never"), or null
 * when the value is present but not a non-negative integer of seconds — the
 * caller warns and stays off.
 */
export function parseIdleExitMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return 0;
  const seconds = Number(raw.trim());
  if (!Number.isInteger(seconds) || seconds < 0) return null;
  return seconds * 1000;
}
