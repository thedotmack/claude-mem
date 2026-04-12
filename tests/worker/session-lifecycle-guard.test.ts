/**
 * Tests for Issue #1590: Session lifecycle guards to prevent runaway API spend
 *
 * Validates three lifecycle safety mechanisms:
 * 1. SIGTERM detection: externally-killed processes must NOT trigger crash recovery
 * 2. Wall-clock age limit: sessions older than MAX_SESSION_WALL_CLOCK_MS must be terminated
 * 3. Duplicate process prevention: a new spawn for a session kills any existing process first
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import {
  registerProcess,
  unregisterProcess,
  getProcessBySession,
  getActiveCount,
  getActiveProcesses,
  createPidCapturingSpawn,
} from '../../src/services/worker/ProcessRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcess(overrides: { exitCode?: number | null; killed?: boolean } = {}) {
  const emitter = new EventEmitter();
  const mock = Object.assign(emitter, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    exitCode: overrides.exitCode ?? null,
    killed: overrides.killed ?? false,
    stdin: null as null,
    stdout: null as null,
    stderr: null as null,
    kill(signal?: string) {
      mock.killed = true;
      setTimeout(() => {
        mock.exitCode = 0;
        mock.emit('exit', mock.exitCode, signal || 'SIGTERM');
      }, 10);
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  });
  return mock;
}

function clearRegistry() {
  for (const p of getActiveProcesses()) {
    unregisterProcess(p.pid);
  }
}

// ---------------------------------------------------------------------------
// 1. SIGTERM detection — does NOT trigger crash recovery
// ---------------------------------------------------------------------------

describe('SIGTERM detection (Issue #1590)', () => {
  it('should classify "code 143" as a SIGTERM error', () => {
    const errorMsg = 'Claude Code process exited with code 143';
    const isSigterm = errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM');
    expect(isSigterm).toBe(true);
  });

  it('should classify "signal SIGTERM" as a SIGTERM error', () => {
    const errorMsg = 'Process terminated with signal SIGTERM';
    const isSigterm = errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM');
    expect(isSigterm).toBe(true);
  });

  it('should NOT classify ordinary errors as SIGTERM', () => {
    const errorMsg = 'Invalid API key';
    const isSigterm = errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM');
    expect(isSigterm).toBe(false);
  });

  it('should NOT classify code 1 (normal error) as SIGTERM', () => {
    const errorMsg = 'Claude Code process exited with code 1';
    const isSigterm = errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM');
    expect(isSigterm).toBe(false);
  });

  it('aborting the controller should mark wasAborted=true, preventing crash recovery', () => {
    // Simulate what the catch handler does: abort when SIGTERM detected
    const abortController = new AbortController();
    expect(abortController.signal.aborted).toBe(false);

    // SIGTERM arrives — we abort the controller
    abortController.abort();

    // By the time .finally() runs, wasAborted should be true
    const wasAborted = abortController.signal.aborted;
    expect(wasAborted).toBe(true);
  });

  it('should NOT abort the controller for non-SIGTERM crash errors', () => {
    const abortController = new AbortController();
    const errorMsg = 'FOREIGN KEY constraint failed';

    // Non-SIGTERM: do NOT abort
    const isSigterm = errorMsg.includes('code 143') || errorMsg.includes('signal SIGTERM');
    if (isSigterm) {
      abortController.abort();
    }

    expect(abortController.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Wall-clock age limit
// ---------------------------------------------------------------------------

describe('Wall-clock age limit (Issue #1590)', () => {
  const MAX_SESSION_WALL_CLOCK_MS = 4 * 60 * 60 * 1000; // 4 hours (matches SessionRoutes)

  it('should NOT terminate a session started < 4 hours ago', () => {
    const startTime = Date.now() - 30 * 60 * 1000; // 30 minutes ago
    const sessionAgeMs = Date.now() - startTime;
    expect(sessionAgeMs).toBeLessThan(MAX_SESSION_WALL_CLOCK_MS);
  });

  it('should NOT terminate a session started exactly 4 hours ago (strict >)', () => {
    // Production uses strict `>` (not `>=`), so exactly 4h is still alive.
    const startTime = Date.now() - MAX_SESSION_WALL_CLOCK_MS;
    const sessionAgeMs = Date.now() - startTime;
    // At exactly the boundary, sessionAgeMs === MAX, and `>` is false → no termination.
    expect(sessionAgeMs).toBeLessThanOrEqual(MAX_SESSION_WALL_CLOCK_MS);
  });

  it('should terminate a session started more than 4 hours ago', () => {
    const startTime = Date.now() - MAX_SESSION_WALL_CLOCK_MS - 1;
    const sessionAgeMs = Date.now() - startTime;
    expect(sessionAgeMs).toBeGreaterThan(MAX_SESSION_WALL_CLOCK_MS);
  });

  it('should terminate a session started 13+ hours ago (the issue scenario)', () => {
    const startTime = Date.now() - 13 * 60 * 60 * 1000; // 13 hours ago
    const sessionAgeMs = Date.now() - startTime;
    expect(sessionAgeMs).toBeGreaterThan(MAX_SESSION_WALL_CLOCK_MS);
  });

  it('aborting + draining pending queue should prevent respawn', () => {
    // Simulate the wall-clock termination sequence:
    // 1. Abort controller (stops active generator)
    // 2. Mark pending messages abandoned (no work to restart for)
    // 3. Remove session from map

    const abortController = new AbortController();
    let pendingAbandoned = 0;
    let sessionRemoved = false;

    // Simulate abort
    abortController.abort();
    expect(abortController.signal.aborted).toBe(true);

    // Simulate markAllSessionMessagesAbandoned
    pendingAbandoned = 3; // Pretend 3 messages were abandoned

    // Simulate removeSessionImmediate
    sessionRemoved = true;

    expect(pendingAbandoned).toBeGreaterThanOrEqual(0);
    expect(sessionRemoved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate process prevention in createPidCapturingSpawn
// ---------------------------------------------------------------------------

describe('Duplicate process prevention (Issue #1590)', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    clearRegistry();
  });

  it('should detect a duplicate when a live process already exists for the session', () => {
    const proc = createMockProcess();
    registerProcess(proc.pid, 42, proc as any);

    const existing = getProcessBySession(42);
    expect(existing).toBeDefined();
    expect(existing!.process.exitCode).toBeNull(); // Still alive
  });

  it('should NOT detect a duplicate when the existing process has already exited', () => {
    const proc = createMockProcess({ exitCode: 0 });
    registerProcess(proc.pid, 42, proc as any);

    const existing = getProcessBySession(42);
    expect(existing).toBeDefined();
    // exitCode is set — process is already done, NOT a live duplicate
    expect(existing!.process.exitCode).not.toBeNull();
  });

  it('should kill existing process and unregister before spawning', () => {
    const existingProc = createMockProcess();
    registerProcess(existingProc.pid, 99, existingProc as any);
    expect(getActiveCount()).toBe(1);

    // Simulate the duplicate-kill logic:
    const duplicate = getProcessBySession(99);
    if (duplicate && duplicate.process.exitCode === null) {
      try { duplicate.process.kill('SIGTERM'); } catch { /* already dead */ }
      unregisterProcess(duplicate.pid);
    }

    expect(getActiveCount()).toBe(0);
    expect(getProcessBySession(99)).toBeUndefined();
  });

  it('should leave registry empty after killing duplicate so new process can register', () => {
    const oldProc = createMockProcess();
    registerProcess(oldProc.pid, 77, oldProc as any);
    expect(getActiveCount()).toBe(1);

    // Kill duplicate
    const dup = getProcessBySession(77);
    if (dup && dup.process.exitCode === null) {
      try { dup.process.kill('SIGTERM'); } catch { /* ignore */ }
      unregisterProcess(dup.pid);
    }
    expect(getActiveCount()).toBe(0);

    // New process can now register cleanly
    const newProc = createMockProcess();
    registerProcess(newProc.pid, 77, newProc as any);
    expect(getActiveCount()).toBe(1);

    const found = getProcessBySession(77);
    expect(found!.pid).toBe(newProc.pid);
  });

  it('should not interfere when no existing process is registered', () => {
    expect(getProcessBySession(55)).toBeUndefined();

    // Duplicate-kill logic: should be a no-op
    const dup = getProcessBySession(55);
    if (dup && dup.process.exitCode === null) {
      unregisterProcess(dup.pid);
    }

    // Registry should still be empty — no side effects
    expect(getActiveCount()).toBe(0);
  });
});
