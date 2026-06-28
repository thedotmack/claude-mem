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
// flush() — session_compressed rollup
// ---------------------------------------------------------------------------

describe('flush() — observer_turn_rollup', () => {
  it('emits exactly one rollup event for N records with correct sums and counts', () => {
    telemetryBuffer.record('session_compressed', {
      outcome: 'ok',
      tokens_input: 1000,
      tokens_output: 200,
      cost_usd: 0.01,
      duration_ms: 800,
      compression_ms: 400,
      model: 'claude-sonnet-4-5',
      fabricated_count: 0,
    });
    telemetryBuffer.record('session_compressed', {
      outcome: 'ok',
      tokens_input: 2000,
      tokens_output: 300,
      cost_usd: 0.02,
      duration_ms: 1200,
      compression_ms: 600,
      model: 'claude-sonnet-4-5',
      fabricated_count: 1,
    });
    telemetryBuffer.record('session_compressed', {
      outcome: 'error',
      tokens_input: 500,
      tokens_output: 100,
      cost_usd: 0.005,
      duration_ms: 300,
      // compression_ms deliberately omitted — must be skipped from avg
      model: 'claude-haiku-3-5',
      fabricated_count: 0,
    });

    telemetryBuffer.flush();

    // Exactly one rollup event
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
    // top_model: claude-sonnet-4-5 appeared twice vs claude-haiku-3-5 once
    expect(p.top_model).toBe('claude-sonnet-4-5');
    expect(p.fabrication_count).toBe(1);
    expect(typeof p.window_start_ts).toBe('number');
    expect(p.window_start_ts).toBeGreaterThan(0);
  });

  it('covers all outcome buckets correctly', () => {
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });
    telemetryBuffer.record('session_compressed', { outcome: 'aborted' });
    telemetryBuffer.record('session_compressed', { outcome: 'invalid_output' });
    telemetryBuffer.record('session_compressed', { outcome: 'error' });
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });

    telemetryBuffer.flush();

    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.count).toBe(5);
    expect(p.outcomes_ok).toBe(2);
    expect(p.outcomes_error).toBe(1);
    expect(p.outcomes_aborted).toBe(1);
    expect(p.outcomes_invalid_output).toBe(1);
  });

  it('omits top_model when no model strings are recorded', () => {
    telemetryBuffer.record('session_compressed', { outcome: 'error' });

    telemetryBuffer.flush();

    const p = (postHogCaptureCalls[0] as { properties: Record<string, unknown> }).properties;
    expect(p.top_model).toBeUndefined();
  });

  it('resets bucket after flush so a second flush emits nothing', () => {
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(1);

    postHogCaptureCalls.length = 0;
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flush() — context_injected rollup
// ---------------------------------------------------------------------------

describe('flush() — context_injected_rollup', () => {
  it('emits one rollup event with correct token sums and averages', () => {
    telemetryBuffer.record('context_injected', { outcome: 'ok', tokens_injected: 500 });
    telemetryBuffer.record('context_injected', { outcome: 'ok', tokens_injected: 1500 });
    telemetryBuffer.record('context_injected', { outcome: 'error' }); // no tokens — must be skipped from avg

    telemetryBuffer.flush();

    expect(postHogCaptureCalls.length).toBe(1);
    const call = postHogCaptureCalls[0] as { event: string; properties: Record<string, unknown> };
    expect(call.event).toBe('context_injected_rollup');

    const p = call.properties;
    expect(p.count).toBe(3);
    expect(p.total_tokens).toBe(2000);
    // avg_tokens: only 2 records had tokens → 2000 / 2 = 1000
    expect(p.avg_tokens).toBe(1000);
    // outcome split: 2 ok, 1 error — distinguishes failed injections (zero
    // tokens, all errors) from zero-token successes
    expect(p.outcomes_ok).toBe(2);
    expect(p.outcomes_error).toBe(1);
    expect(typeof p.window_start_ts).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Empty bucket — no captureEvent call
// ---------------------------------------------------------------------------

describe('flush() — empty buckets', () => {
  it('emits no events when no records have been buffered', () => {
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(0);
  });

  it('emits only observer_turn_rollup when context_injected bucket is empty', () => {
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });
    telemetryBuffer.flush();

    expect(postHogCaptureCalls.length).toBe(1);
    const event = (postHogCaptureCalls[0] as { event: string }).event;
    expect(event).toBe('observer_turn_rollup');
  });

  it('emits only context_injected_rollup when session_compressed bucket is empty', () => {
    telemetryBuffer.record('context_injected', { outcome: 'ok', tokens_injected: 100 });
    telemetryBuffer.flush();

    expect(postHogCaptureCalls.length).toBe(1);
    const event = (postHogCaptureCalls[0] as { event: string }).event;
    expect(event).toBe('context_injected_rollup');
  });
});

// ---------------------------------------------------------------------------
// start() / stop() interval wiring
// ---------------------------------------------------------------------------

describe('start() / stop() interval wiring', () => {
  it('is idempotent — calling start() twice does not create two intervals', async () => {
    // We verify idempotency indirectly: record an event, call start() twice with
    // a very short interval, wait one tick, stop, then flush manually. If two
    // intervals fired we'd get extra captureEvent calls; idempotency means
    // exactly the expected behaviour.
    //
    // Use a 50ms interval so the test is fast without relying on fake timers
    // (Bun's fake-timer support for setInterval is still evolving).
    telemetryBuffer.start(50);
    telemetryBuffer.start(50); // second call must be a no-op

    telemetryBuffer.record('session_compressed', { outcome: 'ok' });

    // Wait for one interval tick
    await new Promise(resolve => setTimeout(resolve, 80));

    telemetryBuffer.stop();

    // The interval flushed the record automatically
    expect(postHogCaptureCalls.length).toBe(1);
    expect((postHogCaptureCalls[0] as { event: string }).event).toBe('observer_turn_rollup');
  });

  it('stop() clears the interval so no further auto-flushes occur', async () => {
    telemetryBuffer.start(30);
    telemetryBuffer.stop();

    // Record after stop — should NOT be auto-flushed by the stopped interval
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });

    await new Promise(resolve => setTimeout(resolve, 60));

    // Still no captureEvent because interval was stopped
    expect(postHogCaptureCalls.length).toBe(0);

    // Manual flush works fine
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(1);
  });

  it('stop() does not flush — caller must call flush() explicitly', async () => {
    telemetryBuffer.start(100);
    telemetryBuffer.record('session_compressed', { outcome: 'ok' });

    // Stop before the interval fires
    telemetryBuffer.stop();

    // No auto-flush happened
    expect(postHogCaptureCalls.length).toBe(0);

    // Explicit flush after stop() still works
    telemetryBuffer.flush();
    expect(postHogCaptureCalls.length).toBe(1);
  });
});
