import { describe, it, expect } from 'bun:test';
import { IdleExitMonitor, MIN_IDLE_EXIT_MS, parseIdleExitMs } from '../../src/services/worker/idle-exit-monitor.js';

// IdleExitMonitor lives in src/services/worker/idle-exit-monitor.ts (not
// worker-service.ts) for the same reason as runShutdownSequence in
// worker-shutdown.ts: worker-service.ts drags in the isMainModule bootstrap,
// bun:sqlite, the MCP SDK and telemetry, which makes it unsafe to import from
// `bun test`. WorkerService.startIdleExitMonitor() wires this class with its
// real dependencies (SessionManager's recency/queue signals, the Server's
// request stamp, lastAiInteraction), so these tests exercise the production
// idle decision logic directly.
//
// Tests drive tick() explicitly with an injected clock (now) — no fake timers:
// start() still arms a real (unref'd) interval, but at a 60 s cadence it never
// fires inside a test, so every check below is deterministic.

const IDLE_EXIT_MS = 600_000;

interface Harness {
  monitor: IdleExitMonitor;
  state: {
    /** Timestamp of the last session message/generator activity, or null if none. */
    lastSessionActivityAt: number | null;
    queueDepth: number;
    /** Timestamp of the last request start or finish, or null if never. */
    lastRequestAt: number | null;
    /** Requests still open (a viewer stream, a corpus prime). */
    inFlightRequests: number;
    /** Viewer tabs connected to the event stream. */
    viewerClients: number;
    lastAiAt: number | null;
  };
  idleCalls: number[];
  advance: (ms: number) => void;
  now: () => number;
}

function makeHarness(overrides: {
  idleExitMs?: number;
  getQueueDepth?: () => number;
} = {}): Harness {
  let nowMs = 1_000_000;
  const state = {
    lastSessionActivityAt: null as number | null,
    queueDepth: 0,
    lastRequestAt: null as number | null,
    inFlightRequests: 0,
    viewerClients: 0,
    lastAiAt: null as number | null,
  };
  const idleCalls: number[] = [];

  const monitor = new IdleExitMonitor({
    idleExitMs: overrides.idleExitMs ?? IDLE_EXIT_MS,
    // Mirrors SessionManager.hasSessionActivitySince: a session counts only
    // when it saw activity at/after the cutoff — never merely by existing.
    hasSessionActivitySince: (cutoffMs) =>
      state.lastSessionActivityAt !== null && state.lastSessionActivityAt >= cutoffMs,
    getQueueDepth: overrides.getQueueDepth ?? (() => state.queueDepth),
    getLastRequestAt: () => state.lastRequestAt,
    getInFlightRequestCount: () => state.inFlightRequests,
    getViewerClientCount: () => state.viewerClients,
    getLastAiInteractionAt: () => state.lastAiAt,
    onIdle: (idleMs: number) => { idleCalls.push(idleMs); },
    now: () => nowMs,
    // Armed but never fires within a test — checks are explicit tick() calls.
    tickIntervalMs: 60_000,
  });

  return {
    monitor,
    state,
    idleCalls,
    advance: (ms: number) => { nowMs += ms; },
    now: () => nowMs,
  };
}

describe('IdleExitMonitor — arming', () => {
  it('never arms or fires when idleExitMs is 0 (the CLAUDE_MEM_IDLE_EXIT_SEC=0 default)', () => {
    const h = makeHarness({ idleExitMs: 0 });

    h.monitor.start();
    expect(h.monitor.isRunning()).toBe(false);

    h.advance(10_000_000);
    h.monitor.tick();

    expect(h.idleCalls.length).toBe(0);
  });

  it('arms at start() and treats the arm time as the activity baseline', () => {
    const h = makeHarness();

    h.monitor.start();
    expect(h.monitor.isRunning()).toBe(true);

    // Window not yet elapsed from the arm time.
    h.advance(IDLE_EXIT_MS - 1);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);
  });
});

describe('IdleExitMonitor — idle decision', () => {
  it('fires onIdle once, with the observed idle duration, after the window elapses with no activity', () => {
    const h = makeHarness();

    h.monitor.start();
    h.advance(IDLE_EXIT_MS - 1);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
    expect(h.idleCalls[0]).toBe(IDLE_EXIT_MS);
    // Disarmed by its own trigger: later ticks never re-fire.
    expect(h.monitor.isRunning()).toBe(false);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('refreshes the activity clock while sessions saw recent activity', () => {
    const h = makeHarness();

    h.monitor.start();
    h.advance(IDLE_EXIT_MS - 1_000);
    h.state.lastSessionActivityAt = h.now();
    h.monitor.tick(); // refresh: lastActivityAt = now

    // Session activity now older than the window.
    h.state.lastSessionActivityAt = h.now() - (IDLE_EXIT_MS - 1_000);
    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick(); // idle since refresh < window
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick(); // exactly the window since the refresh
    expect(h.idleCalls.length).toBe(1);
  });

  it('exits even when a session object exists but has been quiet since before the window', () => {
    const h = makeHarness();

    h.monitor.start();
    // A standing session (memory seat) that last did work well before the
    // window: existence alone must not pin the worker awake.
    h.state.lastSessionActivityAt = h.now() - (IDLE_EXIT_MS * 10);

    h.advance(IDLE_EXIT_MS);
    h.monitor.tick();

    expect(h.idleCalls.length).toBe(1);
  });

  it('refreshes the activity clock while a host keeps sending requests', () => {
    const h = makeHarness();

    h.monitor.start();
    // A plugin poller hitting the worker keeps it alive: the request
    // timestamp observed at this tick resets the window.
    h.advance(IDLE_EXIT_MS - 1_000);
    h.state.lastRequestAt = h.now();
    h.monitor.tick();

    // No new request since — the window runs from the one above.
    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('starts the window at a request that landed after the previous tick', () => {
    const h = makeHarness();

    h.monitor.start(); // lastActivityAt = T0
    h.advance(300_000);
    // A request lands between ticks (the worker's own boot probes do this).
    h.state.lastRequestAt = h.now();
    h.monitor.tick();

    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('refreshes the activity clock while queue depth is nonzero (queued compression work)', () => {
    const h = makeHarness();

    h.monitor.start();
    h.advance(IDLE_EXIT_MS - 1_000);
    h.state.queueDepth = 3;
    h.monitor.tick();

    h.state.queueDepth = 0;
    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('never exits while a request is still open, however long ago it started (a corpus prime)', () => {
    const h = makeHarness();

    h.monitor.start();
    // One request that started at arm time and is still running: its stamp is old.
    h.state.lastRequestAt = h.now();
    h.state.inFlightRequests = 1;
    h.advance(IDLE_EXIT_MS * 3);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    // It finishes: the window runs from the last tick that saw it open.
    h.state.inFlightRequests = 0;
    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);
    h.advance(1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('never exits while a viewer tab is connected to the event stream', () => {
    const h = makeHarness();

    h.monitor.start();
    h.state.viewerClients = 1;
    h.advance(IDLE_EXIT_MS * 3);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.state.viewerClients = 0;
    h.advance(IDLE_EXIT_MS);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('treats a finished AI interaction newer than the last observed tick as activity', () => {
    const h = makeHarness();

    h.monitor.start(); // lastActivityAt = T0
    h.advance(300_000);
    // A compression finished AFTER the last activity tick (e.g. it outlived
    // the session): its timestamp becomes the activity baseline.
    h.state.lastAiAt = h.now();
    h.monitor.tick();

    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(1);
  });

  it('treats a failing activity read as activity — never exits on an observation error', () => {
    const h = makeHarness({
      getQueueDepth: () => { throw new Error('buffer unavailable'); },
    });

    h.monitor.start();
    h.advance(IDLE_EXIT_MS + 1);

    // Must not throw and must not fire onIdle.
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);
  });
});

describe('parseIdleExitMs — CLAUDE_MEM_IDLE_EXIT_SEC parsing', () => {
  it('maps absent/empty values and 0 to 0 (disabled)', () => {
    expect(parseIdleExitMs(undefined)).toBe(0);
    expect(parseIdleExitMs('')).toBe(0);
    expect(parseIdleExitMs('   ')).toBe(0);
    expect(parseIdleExitMs('0')).toBe(0);
  });

  it('maps valid non-negative integer seconds to milliseconds', () => {
    expect(parseIdleExitMs('600')).toBe(600_000);
    expect(parseIdleExitMs(' 600 ')).toBe(600_000);
    expect(parseIdleExitMs('1')).toBe(1_000);
  });

  it('rejects non-integers and negatives with null (caller warns and stays off)', () => {
    expect(parseIdleExitMs('abc')).toBeNull();
    expect(parseIdleExitMs('1.5')).toBeNull();
    expect(parseIdleExitMs('-1')).toBeNull();
  });

  it('rejects windows whose milliseconds are not a safe integer (1e308 s would be Infinity ms and never fire)', () => {
    expect(parseIdleExitMs('1e308')).toBeNull();
    expect(parseIdleExitMs('Infinity')).toBeNull();
    expect(parseIdleExitMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    expect(parseIdleExitMs('86400')).toBe(86_400_000);
  });

  it('returns windows under the 60 s minimum as given; the worker wiring raises them', () => {
    expect(parseIdleExitMs('5')).toBe(5_000);
    expect(MIN_IDLE_EXIT_MS).toBe(60_000);
  });
});
