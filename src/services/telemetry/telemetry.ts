import { PostHog } from 'posthog-node';
import {
  resolveTelemetryConsent,
  loadTelemetryConfig,
  getOrCreateInstallId,
} from './consent.js';
import { scrubProperties } from './scrub.js';
import { getTelemetryApiKey, getTelemetryHost, buildBaseProperties, buildPersonSet } from './common.js';

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

function getClient(): PostHog {
  if (!client) {
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
    });
  }
  return client;
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
}

/**
 * Flush queued events on graceful shutdown. Races the SDK shutdown against a
 * 3s timeout so a slow/unreachable ingestion host can never hang worker stop.
 * Never rejects.
 */
export async function shutdownTelemetry(): Promise<void> {
  isShutdown = true;
  const current = client;
  client = null;
  if (!current) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      current.shutdown(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } catch {
    // Never let telemetry flushing fail a shutdown.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
