import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postHogCaptureCalls } from '../preload';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { telemetryBuffer } from '../../src/services/telemetry/buffer';

/**
 * TelemetryBuffer unit tests.
 *
 * posthog-node is mocked globally in tests/preload.ts (bunfig.toml preload).
 * We verify buffer behaviour by asserting on postHogCaptureCalls — the same
 * spy array the telemetry-client tests use. Consent is forced on via env vars
 * so captureEvent() passes the consent gate and forwards to the mock client.
 *
 * Phase 2: session_compressed is a PER-SESSION accumulator (keyed by
 * sessionDbId, flushed at session end via flushSession / drainAllSessions /
 * safetyFlush). context_injected stays a TIME-WINDOW rollup drained by flush().
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
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-buffer-test-'));
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
});

afterEach(() => {
  telemetryBuffer.__resetForTests();
});

// ---------------------------------------------------------------------------
// flushSession() — per-session session_compressed rollup (Phase 2)
// ---------------------------------------------------------------------------

describe('flushSession() — observer_turn_rollup', () => {
  it('emits exactly ONE rollup for N records of one session with correct sums and rollup_reason', () => {
    const SID = 42;
    telemetryBuffer.record('session_compressed', SID, {
      outcome: 'ok',
      tokens_input: 1000,
      tokens_output: 200,
      cost_usd: 0.01,
      duration_ms: 800,
      compression_ms: 400,
      model: 'claude-sonnet-4-5',
    });
    telemetryBuffer.record('session_compressed', SID, {
      outcome: 'ok',
      tokens_input: 2000,
      tokens_output: 300,
      cost_usd: 0.02,
      duration_ms: 1200,
      compression_ms: 600,
      model: 'claude-sonnet-4-5',
    });
    telemetryBuffer.record('session_compressed', SID, {
      outcome: 'error',
      tokens_input: 500,
      tokens_output: 100,
      cost_usd: 0.005,
      duration_ms: 300,
      // compression_ms deliberately omitted — must be skipped from avg
      model: 'claude-haiku-3-5',
    });

    const emitted = telemetryBuffer.flushSession(SID, 'session_end');
    expect(emitted).toBe(true);

    // Exactly one rollup event for the whole session
    expect(postHogCaptureCalls.length).toBe(1);
    const call = postHogCaptureCalls[0] as { event: string; properties: Record<string, unknown> };
    expect(call.event).toBe('observer_turn_rollup');

    const p = call.properties;
    expect(p.count).toBe(3);
    expect(p.total_tokens_input).toBe(3500);
    expect(p.total_tokens_output).toBe(600);
    expect(p.total_cost_usd).toBeCloseTo(0.035, 6);
    // avg_duration_ms: (800 + 1200 + 300) / 3 = 766.666...
    expect(p.avg_duration_ms).toBeCloseTo(2300 / 3, 4);
    // avg_compression_ms: only 2 records had it → (400 + 600) / 2 = 500
    expect(p.avg_compression_ms).toBe(500);
    expect(p.outcomes_ok).toBe(2);
    expect(p.outcomes_error).toBe(1);
    expect(p.outcomes_aborted).toBe(0);
    expect(p.outcomes_invalid_output).toBe(0);
    expect(p.top_model).toBe('claude-sonnet-4-5');
    expect(typeof p.window_start_ts).toBe('number');
    expect(p.window_start_ts).toBeGreaterThan(0);
    // Phase 2 metadata
    expect(p.rollup_reason).toBe('session_end');
    expect(p.window_seq).toBe(0);
    // sessionDbId must NEVER appear in emitted props (map key only)
    expect(p.sessionDbId).toBeUndefined();
  });

  it('sums generation-side observation volume and obs_type_* across the session', () => {
    const SID = 7;
    telemetryBuffer.record('session_compressed', SID, {
      outcome: 'ok', cost_usd: 0.04, count: 5,
      obs_type_bugfix: 2, obs_type_discovery: 1, obs_type_decision: 0,
      obs_type_refactor: 1, obs_type_other: 1,
    });
    telemetryBuffer.record('session_compressed', SID, {
      outcome: 'ok', cost_usd: 0.06, count: 3,
      obs_type_bugfix: 0, obs_type_discovery: 2, obs_type_decision: 1,
      obs_type_refactor: 0, obs_type_other: 0,
    });

    expect(telemetryBuffer.flushSession(SID, 'session_end')).toBe(true);
    expect(postHogCaptureCalls.length).toBe(1);
    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;

    // rollup `count` is TURNS (records.length); observations_created is the sum
    // of per-turn observation counts — distinct concepts.
    expect(p.count).toBe(2);
    expect(p.observations_created).toBe(8);
    expect(p.total_cost_usd).toBeCloseTo(0.1, 6);
    // cost-per-observation is now derivable from the rollup alone.
    expect((p.total_cost_usd as number) / (p.observations_created as number)).toBeCloseTo(0.0125, 6);
    expect(p.obs_type_bugfix).toBe(2);
    expect(p.obs_type_discovery).toBe(3);
    expect(p.obs_type_decision).toBe(1);
    expect(p.obs_type_refactor).toBe(1);
    expect(p.obs_type_other).toBe(1);
  });

  it('covers all outcome buckets correctly', () => {
    const SID = 7;
    telemetryBuffer.record('session_compressed', SID, { outcome: 'ok' });
    telemetryBuffer.record('session_compressed', SID, { outcome: 'aborted' });
    telemetryBuffer.record('session_compressed', SID, { outcome: 'invalid_output' });
    telemetryBuffer.record('session_compressed', SID, { outcome: 'error' });
    telemetryBuffer.record('session_compressed', SID, { outcome: 'ok' });

    telemetryBuffer.flushSession(SID, 'session_end');

    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.count).toBe(5);
    expect(p.outcomes_ok).toBe(2);
    expect(p.outcomes_error).toBe(1);
    expect(p.outcomes_aborted).toBe(1);
    expect(p.outcomes_invalid_output).toBe(1);
  });

  it('omits top_model when no model strings are recorded', () => {
    const SID = 9;
    telemetryBuffer.record('session_compressed', SID, { outcome: 'error' });
    telemetryBuffer.flushSession(SID, 'session_end');

    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.top_model).toBeUndefined();
  });

  it('two sessions accumulate independently and each emits its own rollup', () => {
    const A = 100;
    const B = 200;
    telemetryBuffer.record('session_compressed', A, { outcome: 'ok', tokens_input: 10 });
    telemetryBuffer.record('session_compressed', B, { outcome: 'error', tokens_input: 999 });
    telemetryBuffer.record('session_compressed', A, { outcome: 'ok', tokens_input: 20 });

    // Two live buckets
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(2);

    telemetryBuffer.flushSession(A, 'session_end');
    expect(postHogCaptureCalls.length).toBe(1);
    let p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.count).toBe(2);
    expect(p.total_tokens_input).toBe(30);
    expect(p.outcomes_ok).toBe(2);
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(1);

    telemetryBuffer.flushSession(B, 'session_end');
    expect(postHogCaptureCalls.length).toBe(2);
    p = (postHogCaptureCalls[1] as { properties: Record<string, unknown> }).properties;
    expect(p.count).toBe(1);
    expect(p.total_tokens_input).toBe(999);
    expect(p.outcomes_error).toBe(1);
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(0);
  });

  it('re-flush of an already-flushed (absent) session is a safe no-op', () => {
    const SID = 55;
    telemetryBuffer.record('session_compressed', SID, { outcome: 'ok' });

    expect(telemetryBuffer.flushSession(SID, 'session_end')).toBe(true);
    expect(postHogCaptureCalls.length).toBe(1);

    // Second flush — bucket already removed; emits nothing (guards the
    // deleteSession/removeSessionImmediate double-teardown pair).
    expect(telemetryBuffer.flushSession(SID, 'session_end')).toBe(false);
    expect(postHogCaptureCalls.length).toBe(1);

    // Flushing a never-seen session is also a no-op.
    expect(telemetryBuffer.flushSession(99999, 'session_end')).toBe(false);
    expect(postHogCaptureCalls.length).toBe(1);
  });

  it('drops a session_compressed record with a non-numeric session key', () => {
    // @ts-expect-error — exercising the runtime guard against a null key
    telemetryBuffer.record('session_compressed', null, { outcome: 'ok' });
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(0);
    telemetryBuffer.drainAllSessions('worker_shutdown');
    expect(postHogCaptureCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drainAllSessions() — worker_shutdown
// ---------------------------------------------------------------------------

describe('drainAllSessions() — worker_shutdown', () => {
  it('flushes ALL active session buckets with rollup_reason worker_shutdown', () => {
    telemetryBuffer.record('session_compressed', 1, { outcome: 'ok' });
    telemetryBuffer.record('session_compressed', 2, { outcome: 'ok' });
    telemetryBuffer.record('session_compressed', 3, { outcome: 'error' });
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(3);

    telemetryBuffer.drainAllSessions('worker_shutdown');

    expect(postHogCaptureCalls.length).toBe(3);
    for (const c of postHogCaptureCalls) {
      const call = c as { event: string; properties: Record<string, unknown> };
      expect(call.event).toBe('observer_turn_rollup');
      expect(call.properties.rollup_reason).toBe('worker_shutdown');
    }
    // Map drained — memory released before client shutdown.
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(0);
  });

  it('is a no-op when there are no active sessions', () => {
    telemetryBuffer.drainAllSessions('worker_shutdown');
    expect(postHogCaptureCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// safetyFlush() — over-cap partial rollup with window_seq increment
// ---------------------------------------------------------------------------

describe('safetyFlush() — over-cap sessions', () => {
  it('emits a partial rollup for an over-count session, bumps window_seq, and re-arms the bucket', () => {
    const SID = 314;
    // Exceed the hard record cap (SAFETY_MAX_RECORDS = 1000).
    for (let i = 0; i < 1000; i++) {
      telemetryBuffer.record('session_compressed', SID, { outcome: 'ok', tokens_input: 1 });
    }

    telemetryBuffer.safetyFlush();

    // One partial rollup, reason safety_flush, window_seq still 0 (the seq of
    // the window just emitted), count = 1000.
    expect(postHogCaptureCalls.length).toBe(1);
    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.rollup_reason).toBe('safety_flush');
    expect(p.window_seq).toBe(0);
    expect(p.count).toBe(1000);
    expect(p.total_tokens_input).toBe(1000);

    // Bucket re-armed in place (NOT removed): map stays bounded, session keeps
    // accumulating into window_seq 1.
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(1);

    telemetryBuffer.record('session_compressed', SID, { outcome: 'error' });
    telemetryBuffer.flushSession(SID, 'session_end');

    expect(postHogCaptureCalls.length).toBe(2);
    const p2 = (postHogCaptureCalls[1] as { properties: Record<string, unknown> }).properties;
    expect(p2.window_seq).toBe(1);
    expect(p2.rollup_reason).toBe('session_end');
    expect(p2.count).toBe(1);
    // Now fully flushed.
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(0);
  });

  it('leaves under-cap sessions untouched', () => {
    telemetryBuffer.record('session_compressed', 1, { outcome: 'ok' });
    telemetryBuffer.safetyFlush();
    expect(postHogCaptureCalls.length).toBe(0);
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Consent gate — nothing sent when consent is off
// ---------------------------------------------------------------------------

describe('consent off ⇒ nothing sent', () => {
  it('emits no events when DO_NOT_TRACK forces consent off', () => {
    const prev = process.env.DO_NOT_TRACK;
    process.env.DO_NOT_TRACK = '1';
    __resetTelemetryForTests(); // clear cached consent
    try {
      telemetryBuffer.record('session_compressed', 1, { outcome: 'ok' });
      telemetryBuffer.flushSession(1, 'session_end');
      telemetryBuffer.record('session_compressed', 2, { outcome: 'ok' });
      telemetryBuffer.drainAllSessions('worker_shutdown');
      expect(postHogCaptureCalls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = prev;
      __resetTelemetryForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// flush() — context_injected TIME-WINDOW rollup (unchanged path)
// ---------------------------------------------------------------------------

describe('flush() — context_injected_rollup', () => {
  it('emits one rollup event with correct token sums and averages', () => {
    telemetryBuffer.record('context_injected', null, {
      outcome: 'ok', tokens_injected: 500, observation_count: 12, tokens_saved_vs_naive: 4000,
    });
    telemetryBuffer.record('context_injected', null, {
      outcome: 'ok', tokens_injected: 1500, observation_count: 30, tokens_saved_vs_naive: 11000,
    });
    telemetryBuffer.record('context_injected', null, { outcome: 'error' }); // no tokens/obs — skipped from sums

    telemetryBuffer.flush();

    expect(postHogCaptureCalls.length).toBe(1);
    const call = postHogCaptureCalls[0] as { event: string; properties: Record<string, unknown> };
    expect(call.event).toBe('context_injected_rollup');

    const p = call.properties;
    expect(p.count).toBe(3);
    expect(p.total_tokens).toBe(2000);
    expect(p.avg_tokens).toBe(1000);
    // Injection-side observation accounting folded into the rollup.
    expect(p.total_observations_injected).toBe(42);
    expect(p.total_tokens_saved_vs_naive).toBe(15000);
    expect(p.outcomes_ok).toBe(2);
    expect(p.outcomes_error).toBe(1);
    expect(typeof p.window_start_ts).toBe('number');
  });

  it('does NOT flush per-session session_compressed buckets', () => {
    telemetryBuffer.record('session_compressed', 1, { outcome: 'ok' });
    telemetryBuffer.record('context_injected', null, { outcome: 'ok', tokens_injected: 100 });

    telemetryBuffer.flush();

    // Only the context_injected rollup — the session bucket survives flush().
    expect(postHogCaptureCalls.length).toBe(1);
    expect((postHogCaptureCalls[0] as { event: string }).event).toBe('context_injected_rollup');
    expect(telemetryBuffer.__activeSessionBucketCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty buckets — no captureEvent call
// ---------------------------------------------------------------------------

describe('flush() — empty buckets', () => {
  it('emits no events when no records have been buffered', () => {
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// start() / stop() interval wiring
// ---------------------------------------------------------------------------

describe('start() / stop() interval wiring', () => {
  it('is idempotent — calling start() twice does not create two intervals', async () => {
    telemetryBuffer.start(50);
    telemetryBuffer.start(50); // second call must be a no-op

    telemetryBuffer.record('context_injected', null, { outcome: 'ok', tokens_injected: 1 });

    await new Promise(resolve => setTimeout(resolve, 80));

    telemetryBuffer.stop();

    // The interval flushed the time-window record automatically — exactly once.
    expect(postHogCaptureCalls.length).toBe(1);
    expect((postHogCaptureCalls[0] as { event: string }).event).toBe('context_injected_rollup');
  });

  it('stop() clears the interval so no further auto-flushes occur', async () => {
    telemetryBuffer.start(30);
    telemetryBuffer.stop();

    telemetryBuffer.record('context_injected', null, { outcome: 'ok', tokens_injected: 1 });

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(postHogCaptureCalls.length).toBe(0);

    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(1);
  });

  it('stop() does not flush — caller must drain explicitly', async () => {
    telemetryBuffer.start(100);
    telemetryBuffer.record('context_injected', null, { outcome: 'ok', tokens_injected: 1 });

    telemetryBuffer.stop();

    expect(postHogCaptureCalls.length).toBe(0);

    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(1);
  });
});
