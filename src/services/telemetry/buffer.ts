/**
 * TelemetryBuffer — aggregate high-volume telemetry events before forwarding to
 * PostHog.
 *
 * TWO ROLLUP STRATEGIES, deliberately asymmetric:
 *
 *   1. session_compressed → observer_turn_rollup — PER-SESSION accumulator,
 *      keyed by sessionDbId, flushed ONCE at session end (Phase 2). Every
 *      observer turn within a session folds into a single rollup emitted when
 *      the session is torn down (session_end), the worker shuts down
 *      (worker_shutdown), or a periodic safety sweep trips a cap (safety_flush).
 *      This collapses the per-turn stream to ~one event per session.
 *
 *   2. context_injected → context_injected_rollup — TIME-WINDOW accumulator,
 *      a single module-level bucket flushed every 5 minutes. context_injected
 *      is a HOOK-level event (no sessionDbId in scope — see SearchRoutes.ts),
 *      so it CANNOT be keyed by session. It stays a wall-clock rollup. Do NOT
 *      "unify" these two paths — the asymmetry is intentional and load-bearing.
 *
 * Usage:
 *   telemetryBuffer.start();                          // worker startup
 *   telemetryBuffer.record('session_compressed', id, props);  // per-session
 *   telemetryBuffer.record('context_injected', null, props);  // time-window
 *   telemetryBuffer.flushSession(id, 'session_end');  // at session teardown
 *   telemetryBuffer.drainAllSessions('worker_shutdown'); // before client.shutdown()
 *   telemetryBuffer.flush();                          // time-window buckets only
 *   telemetryBuffer.stop();                           // clears interval, no flush
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
  /**
   * Monotonic partial-flush counter. A session that never trips a safety_flush
   * emits exactly one rollup with window_seq:0. A long-lived session that trips
   * the safety sweep emits window_seq:0,1,2,… so partial rollups are
   * distinguishable and order-recoverable in PostHog.
   */
  windowSeq: number;
}

interface ContextInjectedBucket {
  records: ContextInjectedRecord[];
  windowStartTs: number;
}

/** Reason a session_compressed bucket was flushed (closed enum). */
export type RollupReason = 'session_end' | 'worker_shutdown' | 'safety_flush';

// ---------------------------------------------------------------------------
// Bucket state — module-level singletons reset on each flush
// ---------------------------------------------------------------------------

// Per-session accumulators for session_compressed (Phase 2). Keyed by
// sessionDbId; one bucket per active session, flushed at session end. The
// sessionDbId is ONLY a map key — it is never copied into emitted props (not
// whitelisted, install-correlatable). See computeSessionCompressedRollup.
const sessionCompressedBuckets: Map<number, SessionCompressedBucket> = new Map();
// Time-window bucket for context_injected (hook-level, no sessionDbId). See
// the file header for why this path stays a wall-clock rollup.
let contextInjectedBucket: ContextInjectedBucket | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let safetyHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// safety_flush thresholds. A session bucket older than MAX_AGE_MS or holding
// more than MAX_RECORDS gets a partial rollup so (a) a forgotten/never-torn-down
// session still reports and (b) per-session memory stays bounded. Chosen to be
// generous: most sessions flush at session_end well before either trips, so the
// common case is still exactly ONE rollup per session.
// ---------------------------------------------------------------------------
const SAFETY_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const SAFETY_MAX_AGE_MS = 60 * 60 * 1000;       // 1 hour
const SAFETY_MAX_RECORDS = 1000;                // hard memory cap per session

// ---------------------------------------------------------------------------
// Rollup computation helpers
// ---------------------------------------------------------------------------

function computeSessionCompressedRollup(
  bucket: SessionCompressedBucket,
  rollupReason: RollupReason
): Record<string, unknown> {
  const { records, windowStartTs, windowSeq } = bucket;
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
    // Phase 2: why this rollup was emitted (session_end | worker_shutdown |
    // safety_flush) and the partial-flush sequence number for long-lived
    // sessions that tripped a safety sweep.
    rollup_reason: rollupReason,
    window_seq: windowSeq,
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
   *
   * @param event  'session_compressed' (per-session) | 'context_injected' (time-window)
   * @param sessionDbId  REQUIRED for 'session_compressed' — the per-session
   *   accumulator key. MUST be null for 'context_injected' (no session in
   *   scope). A session_compressed record with a null/non-numeric id is dropped
   *   rather than misrouted — telemetry never throws, so we swallow silently.
   * @param props  the (already-scrubbed) property bag for this occurrence.
   */
  record(
    event: 'session_compressed' | 'context_injected',
    sessionDbId: number | null,
    props: Record<string, unknown>
  ): void {
    const now = Date.now();
    if (event === 'session_compressed') {
      if (typeof sessionDbId !== 'number') {
        // No session key ⇒ we can't accumulate per-session. Drop rather than
        // crash or misroute. Telemetry is fire-and-forget.
        return;
      }
      let bucket = sessionCompressedBuckets.get(sessionDbId);
      if (!bucket) {
        bucket = { records: [], windowStartTs: now, windowSeq: 0 };
        sessionCompressedBuckets.set(sessionDbId, bucket);
      }
      bucket.records.push(props as SessionCompressedRecord);
    } else {
      if (!contextInjectedBucket) {
        contextInjectedBucket = { records: [], windowStartTs: now };
      }
      contextInjectedBucket.records.push(props as ContextInjectedRecord);
    }
  },

  /**
   * Flush ONE session's accumulated session_compressed records into a single
   * observer_turn_rollup, then remove the bucket. Called at session teardown
   * (session_end) and by the safety sweep (safety_flush).
   *
   * Removing the bucket is what makes a double-flush a safe no-op: a session
   * that is torn down twice (deleteSession after removeSessionImmediate, or
   * vice versa) finds no bucket on the second call and emits nothing.
   *
   * @returns true if a rollup was emitted (bucket had records), else false.
   */
  flushSession(sessionDbId: number, reason: RollupReason): boolean {
    const bucket = sessionCompressedBuckets.get(sessionDbId);
    if (!bucket || bucket.records.length === 0) {
      // Always drop an empty bucket so it can't linger.
      sessionCompressedBuckets.delete(sessionDbId);
      return false;
    }
    const rollup = computeSessionCompressedRollup(bucket, reason);
    sessionCompressedBuckets.delete(sessionDbId);
    captureEvent('observer_turn_rollup', rollup);
    return true;
  },

  /**
   * Drain EVERY active session bucket as a single rollup each, with the given
   * reason. Called from shutdownTelemetry() BEFORE the PostHog client is shut
   * down — this is the single safe drain point for worker_shutdown (the
   * SessionManager teardown path runs too late; see telemetry.ts shutdown
   * ordering). Snapshot the keys first because flushSession mutates the map.
   */
  drainAllSessions(reason: RollupReason): void {
    for (const sessionDbId of Array.from(sessionCompressedBuckets.keys())) {
      telemetryBuffer.flushSession(sessionDbId, reason);
    }
  },

  /**
   * Periodic safety sweep: emit a partial rollup for any session whose bucket
   * exceeds the max age OR max record count, then re-arm that bucket (reset its
   * records + window, bump windowSeq) so a long-lived session keeps reporting
   * and per-session memory stays bounded. Exported helper so the interval and
   * tests can both invoke it deterministically.
   */
  safetyFlush(): void {
    const now = Date.now();
    for (const [sessionDbId, bucket] of Array.from(sessionCompressedBuckets.entries())) {
      const overAge = now - bucket.windowStartTs >= SAFETY_MAX_AGE_MS;
      const overCount = bucket.records.length >= SAFETY_MAX_RECORDS;
      if (!overAge && !overCount) continue;
      if (bucket.records.length === 0) continue;
      const rollup = computeSessionCompressedRollup(bucket, 'safety_flush');
      captureEvent('observer_turn_rollup', rollup);
      // Re-arm in place: same session keeps accumulating into the next window
      // with an incremented sequence number.
      bucket.records = [];
      bucket.windowStartTs = now;
      bucket.windowSeq += 1;
    }
  },

  /**
   * Drain the context_injected TIME-WINDOW bucket → emit one
   * context_injected_rollup, then reset it. Called by the 5-minute interval and
   * at shutdown. Does NOT touch per-session session_compressed buckets — those
   * flush at session end (see flushSession / drainAllSessions).
   */
  flush(): void {
    if (contextInjectedBucket && contextInjectedBucket.records.length > 0) {
      const rollup = computeContextInjectedRollup(contextInjectedBucket);
      contextInjectedBucket = null;
      captureEvent('context_injected_rollup', rollup);
    }
  },

  /**
   * Start the periodic intervals. Idempotent — calling twice is harmless.
   *   - the time-window flush (context_injected) every intervalMs
   *   - the per-session safety sweep every SAFETY_SWEEP_INTERVAL_MS
   *
   * @param intervalMs  Time-window flush interval. Defaults to 5 minutes.
   */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (intervalHandle === null) {
      intervalHandle = setInterval(() => {
        telemetryBuffer.flush();
      }, intervalMs);
      if (intervalHandle && typeof (intervalHandle as NodeJS.Timeout).unref === 'function') {
        (intervalHandle as NodeJS.Timeout).unref();
      }
    }
    if (safetyHandle === null) {
      safetyHandle = setInterval(() => {
        telemetryBuffer.safetyFlush();
      }, SAFETY_SWEEP_INTERVAL_MS);
      if (safetyHandle && typeof (safetyHandle as NodeJS.Timeout).unref === 'function') {
        (safetyHandle as NodeJS.Timeout).unref();
      }
    }
  },

  /**
   * Stop the periodic intervals. Does NOT flush — the caller is responsible for
   * draining explicitly before/after stop() (shutdownTelemetry drains session
   * buckets + flushes the time-window bucket in the right order).
   */
  stop(): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (safetyHandle !== null) {
      clearInterval(safetyHandle);
      safetyHandle = null;
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
    if (safetyHandle !== null) {
      clearInterval(safetyHandle);
      safetyHandle = null;
    }
    sessionCompressedBuckets.clear();
    contextInjectedBucket = null;
  },

  /** Test-only. Number of active per-session buckets (memory-bound assertion). */
  __activeSessionBucketCount(): number {
    return sessionCompressedBuckets.size;
  },
};
