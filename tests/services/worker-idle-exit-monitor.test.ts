import { afterAll, describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { IdleExitMonitor, idleExitWindowMs, MIN_IDLE_EXIT_MS, parseIdleExitMs } from '../../src/services/worker/idle-exit-monitor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

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

  it.each([
    { name: 'recent session activity', elapsed: IDLE_EXIT_MS - 1_000,
      set: (h: Harness) => { h.state.lastSessionActivityAt = h.now(); },
      clear: (h: Harness) => { h.state.lastSessionActivityAt = h.now() - (IDLE_EXIT_MS - 1_000); } },
    { name: 'recent host requests', elapsed: IDLE_EXIT_MS - 1_000,
      set: (h: Harness) => { h.state.lastRequestAt = h.now(); }, clear: (_h: Harness) => {} },
    { name: 'a request between ticks', elapsed: 300_000,
      set: (h: Harness) => { h.state.lastRequestAt = h.now(); }, clear: (_h: Harness) => {} },
    { name: 'queued compression work', elapsed: IDLE_EXIT_MS - 1_000,
      set: (h: Harness) => { h.state.queueDepth = 3; }, clear: (h: Harness) => { h.state.queueDepth = 0; } },
    { name: 'a finished AI interaction between ticks', elapsed: 300_000,
      set: (h: Harness) => { h.state.lastAiAt = h.now(); }, clear: (_h: Harness) => {} },
  ])('restarts the idle window after $name', ({ elapsed, set, clear }) => {
    const h = makeHarness();
    h.monitor.start();
    h.advance(elapsed);
    set(h);
    h.monitor.tick();

    clear(h);
    h.advance(IDLE_EXIT_MS - 1_000);
    h.monitor.tick();
    expect(h.idleCalls.length).toBe(0);

    h.advance(1_000);
    h.monitor.tick();
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

describe('idleExitWindowMs — the window the worker arms with', () => {
  it('is 0 where the worker never idle-exits: absent, empty, 0, and a value it ignores', () => {
    for (const raw of [undefined, '', '  ', '0', 'abc', '-1', '1e308']) expect(idleExitWindowMs(raw)).toBe(0);
  });

  it('raises a window under the minimum to it, and keeps one at or over it', () => {
    expect(idleExitWindowMs('1')).toBe(MIN_IDLE_EXIT_MS);
    expect(idleExitWindowMs('59')).toBe(MIN_IDLE_EXIT_MS);
    expect(idleExitWindowMs('60')).toBe(60_000);
    expect(idleExitWindowMs('600')).toBe(600_000);
  });
});

describe('CLAUDE_MEM_IDLE_EXIT_SEC saved as a JSON number, as the worker reads it', () => {
  // Project-local scratch (gitignored), never the system temp folder, as in
  // tests/worker/http/routes/setup-state-routes.test.ts.
  const scratchRoot = path.join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
  mkdirSync(scratchRoot, { recursive: true });
  const tempDir = mkdtempSync(path.join(scratchRoot, 'idle-exit-number-'));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  /** CLAUDE_MEM_IDLE_EXIT_SEC from a settings.json holding `saved`, loaded the way the worker loads its settings (worker-service.ts initializeBackground). */
  const loadedFromSettingsJson = (name: string, saved: unknown): unknown => {
    const settingsPath = path.join(tempDir, name, 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_IDLE_EXIT_SEC: saved }));
    const fromEnv = process.env.CLAUDE_MEM_IDLE_EXIT_SEC;
    delete process.env.CLAUDE_MEM_IDLE_EXIT_SEC;
    try {
      return SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_IDLE_EXIT_SEC;
    } finally {
      if (fromEnv !== undefined) process.env.CLAUDE_MEM_IDLE_EXIT_SEC = fromEnv;
    }
  };

  it('reaches the worker as a number, and reads as the window its text would give', () => {
    const loaded = loadedFromSettingsJson('sixty', 60);
    // The settings manager turns only a JSON boolean into text, so the number arrives as it was saved.
    expect(typeof loaded).toBe('number');
    expect(parseIdleExitMs(loaded)).toBe(parseIdleExitMs('60'));
    expect(parseIdleExitMs(loaded)).toBe(60_000);
    expect(idleExitWindowMs(loaded)).toBe(60_000);
  });

  it('reads every number the way its text reads: 0 is off, a short window is raised to the minimum, and a fraction, a negative or an overflow is a value the worker ignores', () => {
    // [the number saved, what parseIdleExitMs reads, the window the worker arms with]
    const rows: Array<[number, number | null, number]> = [
      [0, 0, 0],
      [30, 30_000, MIN_IDLE_EXIT_MS],
      [600, 600_000, 600_000],
      [1.5, null, 0],
      [-1, null, 0],
      [1e308, null, 0],
    ];
    rows.forEach(([saved, parsed, window], index) => {
      const loaded = loadedFromSettingsJson(`number-${index}`, saved);
      expect({ saved, parsed: parseIdleExitMs(loaded), window: idleExitWindowMs(loaded) }).toEqual({ saved, parsed, window });
      expect(parseIdleExitMs(loaded)).toBe(parseIdleExitMs(String(saved)));
    });
  });

  it('reads JSON that is neither text nor a number as a value the worker ignores, never throwing', () => {
    [null, [60], { seconds: 60 }].forEach((saved, index) => {
      const loaded = loadedFromSettingsJson(`not-text-${index}`, saved);
      expect({ saved, parsed: parseIdleExitMs(loaded), window: idleExitWindowMs(loaded) }).toEqual({ saved, parsed: null, window: 0 });
    });
  });
});
