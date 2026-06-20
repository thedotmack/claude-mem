/**
 * Unified instrumentation entry point — the FOUNDATION for the telemetry
 * overhaul (Phase 1).
 *
 * `instrument()` is the single call that fans out one observable event to:
 *   (a) the local logger at full fidelity (always), and
 *   (b) the telemetry pipeline (scrubbed + optionally rolled up, PostHog) —
 *       only when a `telemetry` descriptor is supplied AND consent passes.
 *
 * Design rules baked in here (do not regress):
 *   - The local log line ALWAYS happens, even when telemetry is disabled or
 *     throws. Logging must keep working with telemetry off.
 *   - The telemetry branch is wrapped in a swallow-all try/catch. instrument()
 *     MUST NEVER throw — telemetry is fire-and-forget and can never break or
 *     block the worker.
 *   - Consent precedes everything: captureEvent()/telemetryBuffer.record()
 *     both gate on consent internally (captureEvent calls hasConsent() before
 *     anything is sent — see telemetry.ts:82). We do not duplicate that check
 *     here; we rely on the same single source of truth so a future consent
 *     refactor stays in one place.
 *   - Structured props go through scrubProperties (the deny-by-default
 *     whitelist, scrub.ts:168) BEFORE they ever reach a capture sink. We never
 *     bypass the whitelist.
 *
 * The logger is deliberately NOT aware of telemetry — the fan-out lives here so
 * logger.ts never imports the telemetry client (avoids an import cycle and
 * keeps logging functional when telemetry is disabled).
 */

// Logger API + Component/LogContext shapes copied from src/utils/logger.ts.
// Method signatures: logger.debug/info/warn/error/failure(component, message,
// context?, data?) — logger.ts:284-314. `failure` maps onto error level
// (logger.ts:312). Component is the string-literal union (logger.ts:15-52).
import { logger, type Component } from '../../utils/logger.js';
// captureEvent(event, props?, opts?) — telemetry.ts:73. Consent-gated,
// fire-and-forget, never throws.
import { captureEvent } from './telemetry.js';
// scrubProperties(props) — scrub.ts:168. Pure, never throws; deny-by-default
// whitelist, primitive values only.
import { scrubProperties } from './scrub.js';
// telemetryBuffer.record(event, props) — buffer.ts:189. `event` is the closed
// union 'session_compressed' | 'context_injected'.
import { telemetryBuffer } from './buffer.js';

/**
 * Log levels mirror the public logger methods we route through. These are the
 * actual method names on the logger (logger.ts:284-314), NOT the LogLevel enum
 * values — 'failure' is a method that emits at error level.
 */
export type InstrumentLevel = 'debug' | 'info' | 'warn' | 'error' | 'failure';

/**
 * LogContext shape mirrored from logger.ts:54-59. Re-declared (not imported)
 * because logger.ts does not export the interface. A free-form `data` field is
 * pulled out and passed as the logger's 4th arg (Error/object payload), while
 * the rest is the structured context bag.
 */
export interface InstrumentContext {
  sessionId?: string | number;
  memorySessionId?: string;
  correlationId?: string | number;
  /** Passed as the logger's 4th `data` arg (e.g. an Error or detail object). */
  data?: unknown;
  [key: string]: unknown;
}

/**
 * Telemetry descriptor. When present (and consent passes downstream), the same
 * observable event is also captured to PostHog.
 *
 * - `event`: PostHog event name (or a buffer rollup key — see `rollup`).
 * - `props`: structured properties, run through scrubProperties before capture.
 * - `rollup`: how to route the capture.
 *     'session' → route through telemetryBuffer.record('session_compressed')
 *                 into the PER-SESSION accumulator keyed by `sessionDbId`,
 *                 flushed once at session end (Phase 2). REQUIRES sessionDbId.
 *     'hook'    → route through telemetryBuffer.record('context_injected')
 *                 (5-minute time-window rollup) when the event maps cleanly.
 *     'none' (default) → captureEvent() directly (no rollup).
 * - `sessionDbId`: REQUIRED when rollup === 'session' — the per-session
 *   accumulator key. It is ONLY a map key; it never enters the emitted props
 *   (not whitelisted, install-correlatable). Ignored for 'hook'/'none'.
 * - `person`: forward person:true to captureEvent for low-volume lifecycle
 *   events that should build the anonymous install person profile. Only honored
 *   on the direct captureEvent path (the buffer rollup path has no person
 *   concept).
 */
export interface TelemetryDescriptor {
  event: string;
  props?: Record<string, unknown>;
  rollup?: 'session' | 'hook' | 'none';
  /** Per-session accumulator key; required when rollup === 'session'. */
  sessionDbId?: number;
  person?: boolean;
}

// The buffer only accepts these two event keys (buffer.ts:189). A 'session' or
// 'hook' rollup maps cleanly onto exactly one of them; anything else falls back
// to captureEvent so we never silently drop the event.
const ROLLUP_BUFFER_EVENT: Record<'session' | 'hook', 'session_compressed' | 'context_injected'> = {
  session: 'session_compressed',
  hook: 'context_injected',
};

/**
 * Single instrumentation entry point. Always writes the local log line; only
 * touches telemetry when a descriptor is supplied. Never throws.
 *
 * @param component  Component enum value (logger.ts:15-52)
 * @param level      'debug' | 'info' | 'warn' | 'error' | 'failure'
 * @param message    human-readable log message
 * @param ctx        optional LogContext; `ctx.data` becomes the logger's 4th arg
 * @param telemetry  optional descriptor that fans the event out to PostHog
 */
export function instrument(
  component: Component,
  level: InstrumentLevel,
  message: string,
  ctx?: InstrumentContext,
  telemetry?: TelemetryDescriptor
): void {
  // (a) Local log line — ALWAYS. logger methods accept (component, message,
  // context?, data?). We forward the structured context and pull `data` out as
  // the dedicated payload arg, matching logger.ts:284-314.
  const { data, ...rest } = ctx ?? {};
  logger[level](component, message, ctx ? rest : undefined, data);

  // (b) Telemetry fan-out — only when requested. Swallow-all so a telemetry
  // failure can never propagate. Consent is enforced by the capture sinks.
  if (!telemetry) return;
  try {
    const scrubbed = scrubProperties(telemetry.props ?? {});
    const rollup = telemetry.rollup ?? 'none';

    if (rollup !== 'none') {
      const bufferEvent = ROLLUP_BUFFER_EVENT[rollup];
      // The buffer gates on consent internally via its eventual captureEvent
      // flush. record() takes the (already-scrubbed) props bag. The
      // session-scoped path requires a sessionDbId accumulator key; the
      // hook-scoped (context_injected) path is time-windowed and passes null.
      const sessionDbId = rollup === 'session'
        ? (typeof telemetry.sessionDbId === 'number' ? telemetry.sessionDbId : null)
        : null;
      telemetryBuffer.record(bufferEvent, sessionDbId, scrubbed);
      return;
    }

    captureEvent(telemetry.event, scrubbed, telemetry.person ? { person: true } : undefined);
  } catch {
    // Telemetry must never break or block the worker. Swallow everything.
  }
}
