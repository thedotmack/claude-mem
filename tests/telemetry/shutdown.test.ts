import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postHogCaptureCalls } from '../preload';
import {
  __resetTelemetryForTests,
  shutdownTelemetry,
} from '../../src/services/telemetry/telemetry';
import { telemetryBuffer } from '../../src/services/telemetry/buffer';

/**
 * shutdownTelemetry() integration tests.
 *
 * The buffer-level tests in buffer.test.ts call drainAllSessions()/flush()
 * directly, so they never exercise the real graceful-shutdown ordering inside
 * shutdownTelemetry() — they cannot catch the class of bug where the shutdown
 * latch (isShutdown = true / client = null) is set BEFORE the drains run,
 * which makes captureEvent's `if (isShutdown || !hasConsent()) return` gate
 * silently discard every worker_shutdown rollup.
 *
 * These tests drive the public shutdownTelemetry() entry point end to end with
 * consent ON, against the global posthog-node mock (tests/preload.ts), and
 * assert the worker_shutdown rollups ACTUALLY reach postHogCaptureCalls. They
 * FAIL against the buggy "latch first, drain second" ordering and PASS once the
 * drain runs while telemetry is still live.
 */

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_TELEMETRY',
  'CLAUDE_MEM_TELEMETRY_DEBUG',
  'DO_NOT_TRACK',
];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-shutdown-test-'));
  process.env.CLAUDE_MEM_DATA_DIR = tempDir;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  delete process.env.DO_NOT_TRACK;
  __resetTelemetryForTests();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
  telemetryBuffer.__resetForTests();
  __resetTelemetryForTests();
});

beforeEach(() => {
  postHogCaptureCalls.length = 0;
  telemetryBuffer.__resetForTests();
  // Restore a live telemetry client + clear the shutdown latch so each test
  // starts from a fully-live state (shutdownTelemetry sets isShutdown = true).
  __resetTelemetryForTests();
});

afterEach(() => {
  telemetryBuffer.__resetForTests();
  __resetTelemetryForTests();
});

describe('shutdownTelemetry() — drains live before latching shutdown', () => {
  it('emits worker_shutdown rollups for every live session bucket through the real client', async () => {
    // Two live per-session accumulators captured before shutdown.
    telemetryBuffer.record('session_compressed', 1, {
      outcome: 'ok',
      tokens_input: 1000,
      tokens_output: 200,
    });
    telemetryBuffer.record('session_compressed', 1, {
      outcome: 'error',
      tokens_input: 500,
    });
    telemetryBuffer.record('session_compressed', 2, {
      outcome: 'ok',
      tokens_input: 333,
    });
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(2);

    await shutdownTelemetry();

    // The crux: both session rollups must have actually reached the client.
    // Against the buggy ordering (isShutdown set first) this is 0.
    const shutdownRollups = postHogCaptureCalls.filter(
      c => (c as { event?: string }).event === 'observer_turn_rollup'
    );
    expect(shutdownRollups.length).toBe(2);
    for (const c of shutdownRollups) {
      const call = c as { properties: Record<string, unknown> };
      expect(call.properties.rollup_reason).toBe('worker_shutdown');
    }
    // Buckets drained — memory released before client teardown.
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(0);
  });

  it('also drains the time-window context_injected bucket on shutdown', async () => {
    telemetryBuffer.record('session_compressed', 42, { outcome: 'ok' });
    telemetryBuffer.record('context_injected', null, {
      outcome: 'ok',
      tokens_injected: 750,
    });

    await shutdownTelemetry();

    const events = postHogCaptureCalls.map(c => (c as { event?: string }).event);
    // Both the worker_shutdown session rollup AND the context_injected rollup
    // must survive shutdown.
    expect(events).toContain('observer_turn_rollup');
    expect(events).toContain('context_injected_rollup');
  });

  it('latches shutdown so post-shutdown drains emit nothing', async () => {
    telemetryBuffer.record('session_compressed', 7, { outcome: 'ok' });
    await shutdownTelemetry();
    const afterFirst = postHogCaptureCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // After shutdown the latch is set: a late record + drain must be dropped,
    // never queued into a brand-new (never-flushed) client.
    telemetryBuffer.record('session_compressed', 8, { outcome: 'ok' });
    telemetryBuffer.drainAllSessions('worker_shutdown');
    expect(postHogCaptureCalls.length).toBe(afterFirst);
  });
});
