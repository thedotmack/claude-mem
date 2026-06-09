import { PostHog } from 'posthog-node';
import {
  resolveTelemetryConsent,
  loadTelemetryConfig,
  getOrCreateInstallId,
} from './consent.js';
import { scrubProperties } from './scrub.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion =
  typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

/**
 * Publishable PostHog project token (phc_...). Publishable tokens are safe to
 * embed: the capture endpoints are public POST-only ingestion. Empty for now —
 * the maintainer pastes the real phc_ token before enabling ingestion.
 * `CLAUDE_MEM_TELEMETRY_KEY` always overrides this constant.
 */
const TELEMETRY_PUBLIC_KEY = '';

const DEFAULT_HOST = 'https://us.i.posthog.com';

let client: PostHog | null = null;

function getApiKey(): string {
  return process.env.CLAUDE_MEM_TELEMETRY_KEY || TELEMETRY_PUBLIC_KEY;
}

function getClient(): PostHog {
  if (!client) {
    client = new PostHog(getApiKey(), {
      host: process.env.CLAUDE_MEM_TELEMETRY_HOST || DEFAULT_HOST,
      flushAt: 20,
      flushInterval: 10000,
    });
  }
  return client;
}

function buildBaseProperties(): Record<string, unknown> {
  return {
    version: packageVersion,
    os: process.platform,
    arch: process.arch,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtime_version: process.versions.bun ?? process.versions.node,
    is_ci: Boolean(process.env.CI),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

/**
 * Capture a telemetry event. Fire-and-forget, synchronous, never throws,
 * never blocks. Ordering is deliberate:
 *
 *   1. Consent gate (DO_NOT_TRACK > env > telemetry.json > default OFF) —
 *      without consent NOTHING happens, including debug printing.
 *   2. Whitelist scrub — only allowed primitive properties survive.
 *   3. Debug mode (CLAUDE_MEM_TELEMETRY_DEBUG=1) — print payload to stderr,
 *      send nothing.
 *   4. No API key configured — no-op (telemetry ships dark until the
 *      publishable token lands).
 *   5. posthog.capture() — SDK queues in memory and batches in background.
 */
export function captureEvent(event: string, props?: Record<string, unknown>): void {
  try {
    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) {
      return;
    }

    const properties: Record<string, unknown> = scrubProperties({
      ...buildBaseProperties(),
      ...(props ?? {}),
    });
    // Anonymous events: no person profile processing. Added AFTER scrubbing —
    // $-prefixed PostHog directives are not user data and bypass the whitelist.
    properties.$process_person_profile = false;

    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      // Direct stderr write (not console.*): debug mode is a human running the
      // worker in the foreground; repo logger standards forbid console.* in
      // background services (tests/logger-usage-standards.test.ts).
      process.stderr.write('[telemetry] ' + JSON.stringify({ event, properties }) + '\n');
      return;
    }

    if (!getApiKey()) {
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
 * Flush queued events on graceful shutdown. Races the SDK shutdown against a
 * 3s timeout so a slow/unreachable ingestion host can never hang worker stop.
 * Never rejects.
 */
export async function shutdownTelemetry(): Promise<void> {
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
