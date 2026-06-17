/**
 * TelemetryBuffer — aggregate high-volume telemetry events into 5-minute rollup
 * windows before forwarding to PostHog.
 *
 * Instead of one PostHog event per session compression or context injection, we
 * accumulate records in memory and emit a single rollup event per 5-minute
 * window. This cuts PostHog ingest volume proportionally to compression
 * frequency without losing aggregate shape (counts, sums, averages, top model).
 *
 * Usage:
 *   telemetryBuffer.start();              // called once at worker startup
 *   telemetryBuffer.record('session_compressed', props);  // replaces captureEvent
 *   telemetryBuffer.flush();              // called before stop() at shutdown
 *   telemetryBuffer.stop();              // clears interval, no implicit flush
 */

import { captureEvent } from './telemetry.js';

// ---------------------------------------------------------------------------
// Internal bucket types
// ---------------------------------------------------------------------------

interface SessionCompressedRecord {
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: number;
  duration_ms?: number;
  compression_ms?: number;
  outcome?: string;
  model?: string;
  fabricated_count?: number;
  [key: string]: unknown;
}

interface ContextInjectedRecord {
  tokens_injected?: number;
  outcome?: string;
  [key: string]: unknown;
}

interface SessionCompressedBucket {
  records: SessionCompressedRecord[];
  windowStartTs: number;
}

interface ContextInjectedBucket {
  records: ContextInjectedRecord[];
  windowStartTs: number;
}

// ---------------------------------------------------------------------------
// Bucket state — module-level singletons reset on each flush
// ---------------------------------------------------------------------------

let sessionCompressedBucket: SessionCompressedBucket | null = null;
let contextInjectedBucket: ContextInjectedBucket | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Rollup computation helpers
// ---------------------------------------------------------------------------

function computeSessionCompressedRollup(
  bucket: SessionCompressedBucket
): Record<string, unknown> {
  const { records, windowStartTs } = bucket;
  const count = records.length;

  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let totalCostUsd = 0;
  let durationSum = 0;
  let durationCount = 0;
  let compressionSum = 0;
  let compressionCount = 0;
  let outcomesOk = 0;
  let outcomesError = 0;
  let outcomesAborted = 0;
  let outcomesInvalidOutput = 0;
  let fabricationCount = 0;
  const modelFrequency: Map<string, number> = new Map();

  for (const r of records) {
    if (typeof r.tokens_input === 'number' && Number.isFinite(r.tokens_input)) {
      totalTokensInput += r.tokens_input;
    }
    if (typeof r.tokens_output === 'number' && Number.isFinite(r.tokens_output)) {
      totalTokensOutput += r.tokens_output;
    }
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
      totalCostUsd += r.cost_usd;
    }
    if (typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms)) {
      durationSum += r.duration_ms;
      durationCount++;
    }
    if (typeof r.compression_ms === 'number' && Number.isFinite(r.compression_ms)) {
      compressionSum += r.compression_ms;
      compressionCount++;
    }
    if (r.outcome === 'ok') outcomesOk++;
    else if (r.outcome === 'error') outcomesError++;
    else if (r.outcome === 'aborted') outcomesAborted++;
    else if (r.outcome === 'invalid_output') outcomesInvalidOutput++;

    if (typeof r.model === 'string' && r.model) {
      modelFrequency.set(r.model, (modelFrequency.get(r.model) ?? 0) + 1);
    }
    if (typeof r.fabricated_count === 'number' && Number.isFinite(r.fabricated_count)) {
      fabricationCount += r.fabricated_count;
    }
  }

  const rollup: Record<string, unknown> = {
    count,
    total_tokens_input: totalTokensInput,
    total_tokens_output: totalTokensOutput,
    total_cost_usd: totalCostUsd,
    avg_duration_ms: durationCount > 0 ? durationSum / durationCount : 0,
    avg_compression_ms: compressionCount > 0 ? compressionSum / compressionCount : 0,
    outcomes_ok: outcomesOk,
    outcomes_error: outcomesError,
    outcomes_aborted: outcomesAborted,
    outcomes_invalid_output: outcomesInvalidOutput,
    fabrication_count: fabricationCount,
    window_start_ts: windowStartTs,
  };

  // top_model: only present if at least one model string was recorded
  if (modelFrequency.size > 0) {
    let topModel = '';
    let topCount = 0;
    for (const [model, freq] of modelFrequency) {
      if (freq > topCount) {
        topCount = freq;
        topModel = model;
      }
    }
    rollup.top_model = topModel;
  }

  return rollup;
}

function computeContextInjectedRollup(
  bucket: ContextInjectedBucket
): Record<string, unknown> {
  const { records, windowStartTs } = bucket;
  const count = records.length;

  let totalTokens = 0;
  let tokenCount = 0;
  let outcomesOk = 0;
  let outcomesError = 0;

  for (const r of records) {
    // Callers spread ContextInjectStats which uses tokens_injected
    const t = r.tokens_injected;
    if (typeof t === 'number' && Number.isFinite(t)) {
      totalTokens += t;
      tokenCount++;
    }
    // Injection callers only ever emit 'ok' or 'error'. Tracking the split
    // keeps a window of 100% failed injections (zero tokens, all errors)
    // distinguishable from a window of zero-token successes.
    if (r.outcome === 'ok') outcomesOk++;
    else if (r.outcome === 'error') outcomesError++;
  }

  return {
    count,
    total_tokens: totalTokens,
    avg_tokens: tokenCount > 0 ? totalTokens / tokenCount : 0,
    outcomes_ok: outcomesOk,
    outcomes_error: outcomesError,
    window_start_ts: windowStartTs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const telemetryBuffer = {
  /**
   * Record a single high-volume event into the in-memory bucket.
   * Thread-safe in the Node/Bun single-threaded sense.
   */
  record(
    event: 'session_compressed' | 'context_injected',
    props: Record<string, unknown>
  ): void {
    const now = Date.now();
    if (event === 'session_compressed') {
      if (!sessionCompressedBucket) {
        sessionCompressedBucket = { records: [], windowStartTs: now };
      }
      sessionCompressedBucket.records.push(props as SessionCompressedRecord);
    } else {
      if (!contextInjectedBucket) {
        contextInjectedBucket = { records: [], windowStartTs: now };
      }
      contextInjectedBucket.records.push(props as ContextInjectedRecord);
    }
  },

  /**
   * Drain all non-empty buckets → emit one rollup captureEvent per bucket,
   * then reset buckets to empty. Called by the interval and at shutdown.
   */
  flush(): void {
    if (sessionCompressedBucket && sessionCompressedBucket.records.length > 0) {
      const rollup = computeSessionCompressedRollup(sessionCompressedBucket);
      sessionCompressedBucket = null;
      captureEvent('observer_turn_rollup', rollup);
    }

    if (contextInjectedBucket && contextInjectedBucket.records.length > 0) {
      const rollup = computeContextInjectedRollup(contextInjectedBucket);
      contextInjectedBucket = null;
      captureEvent('context_injected_rollup', rollup);
    }
  },

  /**
   * Start the periodic flush interval. Idempotent — calling twice is harmless.
   *
   * @param intervalMs  Flush interval in milliseconds. Defaults to 5 minutes.
   */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (intervalHandle !== null) {
      return;
    }
    intervalHandle = setInterval(() => {
      telemetryBuffer.flush();
    }, intervalMs);
    // Don't prevent the process from exiting if only this interval remains.
    if (intervalHandle && typeof (intervalHandle as NodeJS.Timeout).unref === 'function') {
      (intervalHandle as NodeJS.Timeout).unref();
    }
  },

  /**
   * Stop the periodic flush interval. Does NOT flush — the caller is
   * responsible for calling flush() explicitly before or after stop()
   * (shutdownTelemetry calls both in the right order).
   */
  stop(): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  },

  /**
   * Test-only. Reset all module-level state so tests are isolated.
   * Never called by production code.
   */
  __resetForTests(): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    sessionCompressedBucket = null;
    contextInjectedBucket = null;
  },
};
