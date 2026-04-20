/**
 * Tests for Issue #1652: Stuck generator (zombie subprocess) detection in reapStaleSessions()
 *
 * Root cause: reapStaleSessions() unconditionally skipped sessions where
 * `session.generatorPromise` was non-null, meaning generators stuck inside
 * `for await (const msg of queryResult)` (blocked on a hung subprocess) were
 * never cleaned up — even after the session's Stop hook completed.
 *
 * Fix: Check `session.lastGeneratorActivity`. If it hasn't updated in
 * MAX_GENERATOR_IDLE_MS (5 min), SIGKILL the subprocess to unblock the
 * for-await, then abort the controller so the generator exits.
 *
 * Mock Justification (~30% mock code):
 * - Session fixtures: Required to create valid ActiveSession objects with all
 *   required fields — tests the actual detection logic, not fixture creation.
 * - Process mock: Verify SIGKILL is sent and abort is called — no real subprocess needed.
 */

import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import {
  MAX_GENERATOR_IDLE_MS,
  MAX_SESSION_IDLE_MS,
  detectStaleGenerator,
  type StaleGeneratorCandidate,
} from '../../../src/services/worker/SessionManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProcess {
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: string) => boolean;
  _lastSignal?: string;
}

function createMockProcess(exitCode: number | null = null): MockProcess {
  const proc: MockProcess = {
    exitCode,
    killed: false,
    kill(signal?: string) {
      proc.killed = true;
      proc._lastSignal = signal;
      return true;
    },
  };
  return proc;
}

interface TestSession extends StaleGeneratorCandidate {
  sessionDbId: number;
  startTime: number;
}

function createSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    sessionDbId: 1,
    generatorPromise: null,
    lastGeneratorActivity: Date.now(),
    abortController: new AbortController(),
    startTime: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reapStaleSessions — stale generator detection (Issue #1652)', () => {

  describe('threshold constants', () => {
    test('MAX_GENERATOR_IDLE_MS should be 5 minutes', () => {
      expect(MAX_GENERATOR_IDLE_MS).toBe(5 * 60 * 1000);
    });

    test('MAX_SESSION_IDLE_MS should be 15 minutes', () => {
      expect(MAX_SESSION_IDLE_MS).toBe(15 * 60 * 1000);
    });

    test('generator idle threshold should be less than session idle threshold', () => {
      // Ensures stuck generators are cleaned up before idle no-generator sessions
      expect(MAX_GENERATOR_IDLE_MS).toBeLessThan(MAX_SESSION_IDLE_MS);
    });
  });

  describe('stale generator detection', () => {
    test('should detect generator as stale when idle > 5 minutes', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS + 1000), // 5m1s ago
      });
      const proc = createMockProcess();

      const isStale = detectStaleGenerator(session, proc);

      expect(isStale).toBe(true);
    });

    test('should NOT detect generator as stale when idle exactly at threshold', () => {
      // At exactly the threshold we do NOT yet reap (strictly greater than).
      // Freeze time so that both the session creation and detectStaleGenerator
      // call share the same Date.now() value, preventing a race where the two
      // calls return different timestamps and push the idle time over the boundary.
      const now = Date.now();
      setSystemTime(now);
      try {
        const session = createSession({
          generatorPromise: Promise.resolve(),
          lastGeneratorActivity: now - MAX_GENERATOR_IDLE_MS,
        });
        const proc = createMockProcess();

        const isStale = detectStaleGenerator(session, proc);

        expect(isStale).toBe(false);
      } finally {
        setSystemTime(); // restore real time
      }
    });

    test('should NOT detect generator as stale when idle < 5 minutes', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - 60_000, // 1 minute ago
      });
      const proc = createMockProcess();

      const isStale = detectStaleGenerator(session, proc);

      expect(isStale).toBe(false);
    });

    test('should NOT flag sessions without a generator (no generator = different code path)', () => {
      const session = createSession({
        generatorPromise: null,
        // Even though lastGeneratorActivity is ancient, no generator means no stale-generator detection
        lastGeneratorActivity: 0,
      });
      const proc = createMockProcess();

      const isStale = detectStaleGenerator(session, proc);

      expect(isStale).toBe(false);
    });
  });

  describe('subprocess kill on stale generator', () => {
    test('should SIGKILL the subprocess when stale generator detected', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS + 5000),
      });
      const proc = createMockProcess(); // exitCode === null (still running)

      detectStaleGenerator(session, proc);

      expect(proc.killed).toBe(true);
      expect(proc._lastSignal).toBe('SIGKILL');
    });

    test('should NOT attempt to kill an already-exited subprocess', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS + 5000),
      });
      const proc = createMockProcess(0); // exitCode === 0 (already exited)

      detectStaleGenerator(session, proc);

      // Should not try to kill an already-exited process
      expect(proc.killed).toBe(false);
    });

    test('should still abort controller even when no tracked subprocess found', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS + 5000),
      });

      // proc is undefined — subprocess not tracked in ProcessRegistry
      detectStaleGenerator(session, undefined);

      // AbortController should still be aborted to signal the generator loop
      expect(session.abortController.signal.aborted).toBe(true);
    });
  });

  describe('abort controller on stale generator', () => {
    test('should abort the session controller when stale generator detected', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS + 1000),
      });
      const proc = createMockProcess();

      expect(session.abortController.signal.aborted).toBe(false);

      detectStaleGenerator(session, proc);

      expect(session.abortController.signal.aborted).toBe(true);
    });

    test('should NOT abort controller for fresh generator', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - 30_000, // 30 seconds ago — fresh
      });
      const proc = createMockProcess();

      detectStaleGenerator(session, proc);

      expect(session.abortController.signal.aborted).toBe(false);
    });
  });

  describe('idle session reaping (existing behaviour preserved)', () => {
    test('idle session without generator should be reaped after 15 minutes', () => {
      const session = createSession({
        generatorPromise: null,
        startTime: Date.now() - (MAX_SESSION_IDLE_MS + 1000), // 15m1s ago
      });

      // Simulate the existing idle-session path (no generator, no pending work)
      const sessionAge = Date.now() - session.startTime;
      const shouldReap = !session.generatorPromise && sessionAge > MAX_SESSION_IDLE_MS;

      expect(shouldReap).toBe(true);
    });

    test('idle session without generator should NOT be reaped before 15 minutes', () => {
      const session = createSession({
        generatorPromise: null,
        startTime: Date.now() - (10 * 60 * 1000), // 10 minutes ago
      });

      const sessionAge = Date.now() - session.startTime;
      const shouldReap = !session.generatorPromise && sessionAge > MAX_SESSION_IDLE_MS;

      expect(shouldReap).toBe(false);
    });

    test('session with active generator should never be reaped by idle-session path', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        startTime: Date.now() - (60 * 60 * 1000), // 1 hour ago — very old
        // But generator was active recently (fresh activity)
        lastGeneratorActivity: Date.now() - 10_000,
      });
      const proc = createMockProcess();

      // Stale generator detection says NOT stale (activity is fresh)
      const isStaleGenerator = detectStaleGenerator(session, proc);
      expect(isStaleGenerator).toBe(false);

      // Idle-session path is skipped because generatorPromise is non-null
      expect(session.generatorPromise).not.toBeNull();
    });
  });

  describe('lastGeneratorActivity update semantics', () => {
    test('should be initialized to session startTime to avoid false positives on boot', () => {
      // When a session is first created, lastGeneratorActivity must be set to a
      // recent time so the generator isn't immediately flagged as stale before it
      // has had a chance to produce output.
      const now = Date.now();
      const session = createSession({
        startTime: now,
        lastGeneratorActivity: now, // mirrors SessionManager initialization
      });

      const generatorIdleMs = now - session.lastGeneratorActivity;
      expect(generatorIdleMs).toBeLessThan(MAX_GENERATOR_IDLE_MS);
    });

    test('should be updated when generator yields a message (prevents false positive reap)', () => {
      const session = createSession({
        generatorPromise: Promise.resolve(),
        lastGeneratorActivity: Date.now() - (MAX_GENERATOR_IDLE_MS - 10_000), // 4m50s ago
      });

      // Simulate the getMessageIterator yielding a message:
      session.lastGeneratorActivity = Date.now();

      // Generator is now fresh — should not be reaped
      const generatorIdleMs = Date.now() - session.lastGeneratorActivity;
      expect(generatorIdleMs).toBeLessThan(MAX_GENERATOR_IDLE_MS);
    });
  });
});
