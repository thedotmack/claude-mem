import { PostHog, type EventMessage } from 'posthog-node';
import {
  resolveTelemetryConsent,
  loadTelemetryConfig,
  getOrCreateInstallId,
  isErrorTelemetryEnabled,
} from './consent.js';
import { scrubProperties } from './scrub.js';
import {
  scrubError,
  messageTemplate,
  scrubMessage,
  redactHomeDir,
  redactAbsolutePaths,
} from './error-scrub.js';
import { getTelemetryApiKey, getTelemetryHost, buildBaseProperties, buildPersonSet } from './common.js';
import { telemetryBuffer } from './buffer.js';

let client: PostHog | null = null;
let isShutdown = false;

/**
 * Consent is re-resolved at most once per TTL window so the capture path does
 * not touch the filesystem per event (telemetry.json read). A consent change
 * via the CLI is picked up by a running worker within the TTL.
 */
const CONSENT_CACHE_TTL_MS = 30_000;
let consentCache: { value: boolean; expiresAt: number } | null = null;

function hasConsent(): boolean {
  const now = Date.now();
  if (consentCache && now < consentCache.expiresAt) {
    return consentCache.value;
  }
  const value = resolveTelemetryConsent(process.env, loadTelemetryConfig());
  consentCache = { value, expiresAt: now + CONSENT_CACHE_TTL_MS };
  return value;
}

/**
 * Whether THIS process is the long-lived worker. Only the worker enables
 * uncaught-exception autocapture (enableExceptionAutocapture) — short-lived CLI
 * contexts (cli-telemetry.ts uses its own direct-POST transport, not this
 * client) must never turn it on. The worker flips this on at startup via
 * enableExceptionAutocaptureForWorker() BEFORE the first capture constructs the
 * client. Default off so any non-worker importer of this module (tests, CLI)
 * gets a plain client.
 */
let autocaptureEnabled = false;

/**
 * Called once by the worker at startup to opt into uncaught-exception
 * autocapture. Must run before getClient() first constructs the client (the
 * SDK option is read at construction time). Idempotent / never throws.
 */
export function enableExceptionAutocaptureForWorker(): void {
  autocaptureEnabled = true;
}

function getClient(): PostHog {
  if (!client) {
    // Autocapture is gated by BOTH consent (caller already passed hasConsent())
    // AND the error kill-switch. Even when enabled, every autocaptured
    // $exception is funneled through before_send → applyErrorRateLimit, so the
    // SDK's autocapture can never storm ingest: a fingerprint already sent in
    // the current window returns null (dropped before ingest = not billed).
    const enableAutocapture =
      autocaptureEnabled &&
      isErrorTelemetryEnabled(process.env) &&
      hasConsent();

    client = new PostHog(getTelemetryApiKey(), {
      host: getTelemetryHost(),
      flushAt: 20,
      flushInterval: 10000,
      // posthog-node assumes server deployments and stamps $geoip_disable: true
      // on every event by default, which suppresses ingest-side geolocation.
      // claude-mem's worker runs on the user's own machine, so the ingestion
      // request already originates from their IP — letting PostHog derive
      // coarse location (country/region/city) at ingest. The raw IP is still
      // never attached to events and is discarded on ingest (project setting);
      // see docs/public/telemetry.mdx. This matches the CLI transport
      // (cli-telemetry.ts), whose direct POST never suppressed geolocation.
      disableGeoip: false,
      // posthog-node 5.x: enableExceptionAutocapture installs process
      // uncaughtException/unhandledRejection hooks that emit $exception.
      // (node_modules/posthog-node/dist/types.d.ts:121).
      enableExceptionAutocapture: enableAutocapture,
      // before_send runs for EVERY event just before ingest. Returning null
      // drops the event (types.d.ts:150-155). We use it ONLY to rate-limit
      // $exception events — both the ones our captureException() queues and any
      // the SDK's autocapture produces out-of-band — so the rate-limiter is
      // unconditionally in front of autocapture. Non-exception events pass
      // through untouched. (BeforeSendFn = (event|null) => event|null,
      // types.d.ts:116).
      before_send: errorBeforeSend,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Exception capture: redacted $exception with a MANDATORY in-memory
// rate-limiter / deduper. posthog-node has NO built-in exception rate limit, so
// without this an error loop would bill one ingested event per occurrence.
// ---------------------------------------------------------------------------

/** Send at most one $exception per fingerprint per this window. */
const ERROR_RATELIMIT_WINDOW_MS = 60_000;
/**
 * Hard cap on the dedupe map size so a pathological stream of UNIQUE
 * fingerprints can't grow it without bound. When exceeded, the least-recently
 * ACTIVE entry (by max(lastSentTs, firstTs)) is evicted (LRU) so a hot,
 * still-firing error isn't evicted ahead of a genuinely stale one. Bounds
 * worst-case memory to O(MAX) small records.
 */
const ERROR_FINGERPRINT_MAX = 500;

type ErrorRateState = {
  /** Total occurrences seen this window (including dropped ones). */
  count: number;
  /** First time this fingerprint was seen (used for eviction ordering). */
  firstTs: number;
  /** Last time we actually SENT this fingerprint (0 = never sent yet). */
  lastSentTs: number;
};

const errorRateMap = new Map<string, ErrorRateState>();

/**
 * Stable fingerprint for an error: type + normalized message TEMPLATE + top
 * stack frame. messageTemplate() collapses varying numbers/ids/quoted values so
 * "User 12 not found" and "User 9999 not found" share one fingerprint. Pure /
 * never throws.
 */
function fingerprintError(type: string, message: string, stack: string): string {
  let topFrame = '';
  try {
    const lines = (stack || '').split('\n').map(l => l.trim()).filter(Boolean);
    // First line is usually the "Type: message" header; the first real frame
    // begins with "at ". Prefer that; fall back to the second line.
    topFrame = lines.find(l => l.startsWith('at ')) ?? lines[1] ?? '';
  } catch {
    topFrame = '';
  }
  return `${type}::${messageTemplate(message)}::${topFrame}`.slice(0, 400);
}

/**
 * Rate-limit / dedupe decision for a fingerprint. Returns whether to SEND and
 * the occurrence count to attach. Bounds the map size by evicting the oldest
 * entries. Pure side effect on errorRateMap; never throws.
 */
function applyErrorRateLimit(
  fingerprint: string,
  now: number
): { send: boolean; count: number } {
  try {
    let state = errorRateMap.get(fingerprint);
    if (!state) {
      // Bound the map BEFORE inserting a new key. Evict the least-recently
      // ACTIVE entry (LRU): order by the most recent of lastSentTs / firstTs so
      // a hot, still-firing fingerprint outlives a genuinely stale one.
      if (errorRateMap.size >= ERROR_FINGERPRINT_MAX) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of errorRateMap) {
          const activity = Math.max(v.lastSentTs, v.firstTs);
          if (activity < oldestTs) {
            oldestTs = activity;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) errorRateMap.delete(oldestKey);
      }
      state = { count: 1, firstTs: now, lastSentTs: now };
      errorRateMap.set(fingerprint, state);
      return { send: true, count: 1 };
    }
    state.count += 1;
    if (now - state.lastSentTs >= ERROR_RATELIMIT_WINDOW_MS) {
      state.lastSentTs = now;
      const count = state.count;
      // Reset the occurrence counter for the next window so each sent event
      // carries the count accumulated since the last send.
      state.count = 0;
      return { send: true, count };
    }
    return { send: false, count: state.count };
  } catch {
    // On any failure, fail CLOSED (don't send) — never risk a storm.
    return { send: false, count: 0 };
  }
}

/**
 * Private marker our manual captureException() stamps into additionalProperties
 * (which lands in event.properties before before_send runs). Its presence tells
 * errorBeforeSend "this $exception was ALREADY redacted + rate-limited by the
 * manual path — pass it through unchanged, just strip this marker so it never
 * ships to PostHog." Events WITHOUT it are SDK autocapture and get the full
 * redaction + rate-limit treatment. Never sent to ingest.
 */
const RATE_LIMITED_SENTINEL = '__cm_rate_limited';

/**
 * Redacts a single frame `filename` (or any path-bearing string): home dir → ~,
 * then absolute path → basename. Reuses the error-scrub helpers (pure/total).
 * Never throws.
 */
function redactFilename(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length === 0) return '';
    return redactAbsolutePaths(redactHomeDir(value));
  } catch {
    return '';
  }
}

/**
 * Fully REDACTS an SDK-autocaptured $exception event in place: posthog-node's
 * addSourceContext reads the user's real source files off disk and attaches
 * raw `context_line`/`pre_context`/`post_context` (SOURCE CODE) plus
 * `filename` to every frame, and the RAW unredacted message in `value`. This
 * strips all of it. Mutates and returns the same props object. Never throws.
 */
function redactAutocapturedExceptionList(props: Record<string, unknown>): void {
  const list = props.$exception_list;
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const ex = entry as Record<string, unknown>;
    // Redact the raw message.
    if (typeof ex.value === 'string') ex.value = scrubMessage(ex.value);
    // Redact / strip each frame.
    const trace = ex.stacktrace as { frames?: unknown } | undefined;
    const frames = trace?.frames;
    if (Array.isArray(frames)) {
      for (const frame of frames) {
        if (!frame || typeof frame !== 'object') continue;
        const f = frame as Record<string, unknown>;
        // DELETE raw source lines entirely — never send them.
        delete f.context_line;
        delete f.pre_context;
        delete f.post_context;
        // Redact the absolute filename to a basename (home → ~).
        if (typeof f.filename === 'string') f.filename = redactFilename(f.filename);
        // function/lineno/colno are lower-risk — left as-is.
      }
    }
  }
}

/**
 * before_send hook applied to the worker client. It ONLY governs $exception
 * events; every other event passes through unchanged.
 *
 * posthog-node runs before_send for BOTH our manual captureException() events
 * AND the SDK's uncaught-exception autocapture, so this hook MUST distinguish
 * them:
 *
 *  - MANUAL (carries RATE_LIMITED_SENTINEL): already redacted by scrubError and
 *    already rate-limited/counted by captureException's applyErrorRateLimit
 *    call. Re-running the limiter here would double-count (corrupting
 *    occurrence_count) and split the fingerprint keyspace. So we pass it through
 *    UNCHANGED, only deleting the private sentinel so it never reaches ingest.
 *
 *  - AUTOCAPTURE (no sentinel): posthog-node's addSourceContext has attached the
 *    user's RAW source code (context_line/pre_context/post_context) and the RAW
 *    unredacted message + absolute filenames. We FULLY REDACT the
 *    $exception_list, force $process_person_profile:false, then apply the
 *    fingerprint rate-limiter (returning null drops duplicates before billing).
 *
 * NEVER throws. On ANY error we return null (DROP) rather than risk shipping an
 * unredacted autocaptured event — failing closed is the safe one-way-door
 * default here. The error-scrub helpers are pure/total so this is belt-and-
 * suspenders.
 */
function errorBeforeSend(event: EventMessage | null): EventMessage | null {
  try {
    if (!event || typeof event !== 'object') return event;
    const ev = event;
    if (ev.event !== '$exception') return event;

    const props = (ev.properties ?? {}) as Record<string, unknown>;

    // MANUAL path: already redacted + counted. Strip the sentinel and pass
    // through unchanged — do NOT re-redact or re-run the limiter.
    if (props[RATE_LIMITED_SENTINEL]) {
      try {
        delete props[RATE_LIMITED_SENTINEL];
        ev.properties = props;
      } catch {
        /* best-effort marker strip */
      }
      return event;
    }

    // AUTOCAPTURE path (no sentinel): redact the raw source/message the SDK
    // attached BEFORE anything else, so even an early return can't leak.
    redactAutocapturedExceptionList(props);
    props.$process_person_profile = false;
    ev.properties = props;

    // Derive a fingerprint from the (now-redacted) attached data. posthog-node's
    // autocapture stamps $exception_list; fall back to type/message props.
    let type = 'Error';
    let message = '';
    let stack = '';
    try {
      const list = props.$exception_list;
      if (Array.isArray(list) && list[0] && typeof list[0] === 'object') {
        const first = list[0] as Record<string, unknown>;
        if (typeof first.type === 'string') type = first.type;
        if (typeof first.value === 'string') message = first.value;
        const trace = (first.stacktrace as { frames?: unknown[] } | undefined)?.frames;
        if (Array.isArray(trace) && trace.length > 0) {
          stack = 'at ' + JSON.stringify(trace[trace.length - 1]).slice(0, 200);
        }
      }
    } catch {
      /* fall through to prop-based fingerprint */
    }
    if (typeof props.$exception_type === 'string') type = props.$exception_type;
    if (typeof props.$exception_message === 'string') message = props.$exception_message;

    // fingerprintError already applies messageTemplate internally — pass the
    // raw (redacted) message, do not pre-template it (S1).
    const fingerprint = fingerprintError(type, message, stack);
    const decision = applyErrorRateLimit(fingerprint, Date.now());
    if (!decision.send) return null; // dropped before ingest — not billed
    try {
      props.occurrence_count = decision.count;
      ev.properties = props;
    } catch {
      /* property attach is best-effort */
    }
    return event;
  } catch {
    // Fail CLOSED: dropping is strictly safer than risking an unredacted leak.
    return null;
  }
}

/**
 * Capture a REAL exception to PostHog Error Tracking ($exception) with the
 * error message + trimmed stack REDACTED by error-scrub.ts. Fire-and-forget,
 * synchronous, never throws, never blocks. Ordering mirrors captureEvent:
 *
 *   1. Consent gate (same hasConsent() as analytics) AND the error kill-switch
 *      (CLAUDE_MEM_TELEMETRY_ERRORS) — either off ⇒ nothing happens.
 *   2. Shutdown latch — late errors are dropped, not queued into a dead client.
 *   3. Redact the error (error-scrub: allow-then-redact, NOT the property
 *      whitelist — that would drop free-form text).
 *   4. Rate-limit / dedupe by fingerprint — at most one send per fingerprint
 *      per window; occurrence count attached. Mandatory: no unbounded stream.
 *   5. Optional structured context goes through scrubProperties (the same
 *      deny-by-default whitelist as everything else). Error text/stack are the
 *      ONLY values that take the error-scrub path.
 *   6. Debug mode prints to stderr and sends nothing.
 *   7. client.captureException(error, distinctId, additionalProperties):
 *      $process_person_profile:false (no person profile for $exception) plus the
 *      redacted fields + whitelisted context.
 *
 * SDK signature (verified node_modules/posthog-node/dist/client.d.ts:1031):
 *   captureException(error: unknown, distinctId?: string,
 *     additionalProperties?: Record<string|number, any>, ...): void
 * distinctId is the 2nd positional arg; directives like
 * $process_person_profile go in additionalProperties (3rd arg).
 */
export function captureException(
  err: unknown,
  ctx?: Record<string, unknown>
): void {
  try {
    if (isShutdown || !hasConsent() || !isErrorTelemetryEnabled(process.env)) {
      return;
    }

    const scrubbed = scrubError(err);
    const fingerprint = fingerprintError(scrubbed.type, scrubbed.message, scrubbed.stack);
    const decision = applyErrorRateLimit(fingerprint, Date.now());
    if (!decision.send) {
      return;
    }

    // Structured context (NOT the message/stack) goes through the whitelist.
    const whitelistedContext = scrubProperties({
      ...buildBaseProperties(),
      ...(ctx ?? {}),
    });

    const additionalProperties: Record<string, unknown> = {
      ...whitelistedContext,
      // No person profile for exceptions (anti-pattern guard) — same directive
      // as high-volume operational events in captureEvent.
      $process_person_profile: false,
      // Redacted free-form error fields. These are NOT user-identifying and
      // bypass the property whitelist by design (error-scrub already redacted
      // home dir, paths, URLs, emails, keys, tokens).
      $exception_message: scrubbed.message,
      $exception_type: scrubbed.type,
      error_message: scrubbed.message,
      error_type: scrubbed.type,
      error_stack: scrubbed.stack,
      occurrence_count: decision.count,
      // Private sentinel: tells errorBeforeSend this $exception is ALREADY
      // redacted + rate-limited here, so before_send must NOT re-run the limiter
      // (which would double-count occurrence_count and split the keyspace).
      // before_send deletes it so it never ships to PostHog. (B1 fix.)
      [RATE_LIMITED_SENTINEL]: true,
    };

    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      process.stderr.write(
        '[telemetry] ' + JSON.stringify({ event: '$exception', additionalProperties }) + '\n'
      );
      return;
    }

    if (!getTelemetryApiKey()) {
      return;
    }

    // Pass a redacted Error (not the raw one) so the SDK never re-derives an
    // un-redacted stack/message: the SDK reads .message/.stack/.name off the
    // object we hand it.
    const safeError = new Error(scrubbed.message);
    safeError.name = scrubbed.type;
    safeError.stack = scrubbed.stack || `${scrubbed.type}: ${scrubbed.message}`;

    getClient().captureException(safeError, getOrCreateInstallId(), additionalProperties);
  } catch {
    // Exception capture must NEVER throw into its caller (esp. the logger).
  }
}

/**
 * Capture a telemetry event. Fire-and-forget, synchronous, never throws,
 * never blocks. Ordering is deliberate:
 *
 *   1. Consent gate (DO_NOT_TRACK > env > telemetry.json > default ON) —
 *      without consent NOTHING happens, including debug printing.
 *   2. Whitelist scrub — only allowed primitive properties survive.
 *   3. Debug mode (CLAUDE_MEM_TELEMETRY_DEBUG=1) — print payload to stderr,
 *      send nothing.
 *   4. No API key configured — no-op (telemetry ships dark until the
 *      publishable token lands).
 *   5. posthog.capture() — SDK queues in memory and batches in background.
 *
 * Two event classes (opts.person):
 *   - Lifecycle events (worker_started, install_*) pass person: true. They are
 *     low-volume and build an anonymous person profile keyed to the random
 *     install UUID, which is what makes PostHog's retention / stickiness /
 *     lifecycle / cohort insights work. Person properties are restricted to
 *     PERSON_PROPERTY_KEYS — the same whitelisted enums as event properties.
 *   - Everything else (high-volume operational events) stays profile-less.
 */
export function captureEvent(
  event: string,
  props?: Record<string, unknown>,
  opts?: { person?: boolean }
): void {
  try {
    // Once shutdown has flushed the client, late events (e.g. a request that
    // raced graceful stop) are dropped rather than queued in a new client
    // that would never be flushed.
    if (isShutdown || !hasConsent()) {
      return;
    }

    const properties: Record<string, unknown> = scrubProperties({
      ...buildBaseProperties(),
      ...(props ?? {}),
    });
    // $-prefixed PostHog directives are not user data and bypass the whitelist;
    // they are added AFTER scrubbing.
    if (opts?.person) {
      properties.$set = buildPersonSet(properties);
    } else {
      properties.$process_person_profile = false;
    }

    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      // Direct stderr write (not console.*): debug mode is a human running the
      // worker in the foreground; repo logger standards forbid console.* in
      // background services (tests/logger-usage-standards.test.ts).
      process.stderr.write('[telemetry] ' + JSON.stringify({ event, properties }) + '\n');
      return;
    }

    if (!getTelemetryApiKey()) {
      return;
    }

    getClient().capture({
      distinctId: getOrCreateInstallId(),
      event,
      properties,
    });
  } catch {
    // Telemetry must never break the worker. Swallow everything.
  }
}

/**
 * Test-only. The module state (singleton client, 30s consent TTL cache,
 * shutdown latch) is process-wide, and the whole bun test suite shares one
 * process — without a reset, a test asserting client construction inherits
 * whatever earlier test files did. Never called by production code.
 */
export function __resetTelemetryForTests(): void {
  client = null;
  consentCache = null;
  isShutdown = false;
  autocaptureEnabled = false;
  errorRateMap.clear();
}

/**
 * Test-only accessor for the before_send rate-limit hook, so tests can simulate
 * the SDK's autocapture path (which calls before_send out-of-band) without a
 * real client. Never used by production code.
 */
export function __errorBeforeSendForTests(event: EventMessage | null): EventMessage | null {
  return errorBeforeSend(event);
}

/**
 * Flush queued events on graceful shutdown. Races the SDK shutdown against a
 * 3s timeout so a slow/unreachable ingestion host can never hang worker stop.
 * Never rejects.
 */
export async function shutdownTelemetry(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    telemetryBuffer.stop();
    // Drain ALL active per-session accumulators FIRST, while telemetry is
    // still fully LIVE (isShutdown is NOT yet set and `client` is NOT yet
    // nulled) — captureEvent's `if (isShutdown || !hasConsent()) return`
    // gate must still pass so every in-flight session emits its single
    // observer_turn_rollup (rollup_reason: 'worker_shutdown') into the live
    // client's queue (constructing the client lazily via getClient() if no
    // event was ever emitted before shutdown). This is the single safe drain
    // point: the SessionManager teardown path (deleteSession → flushSession)
    // runs in performGracefulShutdown, AFTER beforeGracefulShutdown has
    // already called shutdownTelemetry — too late.
    telemetryBuffer.drainAllSessions('worker_shutdown');
    // Then drain the time-window context_injected bucket — still live.
    telemetryBuffer.flush();
    // Capture whatever client the drains queued into (or that earlier events
    // constructed), THEN latch shutdown and detach the singleton. Reading
    // `client` here — after the drains — is what guarantees we tear down the
    // exact instance the rollups landed in, rather than an empty pre-drain
    // snapshot. Any event that races past this point is dropped (isShutdown)
    // rather than queued into a fresh client that would never be flushed.
    const current = client;
    isShutdown = true;
    client = null;
    if (!current) {
      return;
    }
    // Flush + tear down the captured client, racing a 3s timeout so a
    // slow/unreachable ingestion host can never hang worker stop.
    await Promise.race([
      current.shutdown(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } catch {
    // Never let telemetry flushing fail a shutdown. Ensure the latch is set
    // even if a drain threw before we reached it above.
    isShutdown = true;
    client = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
