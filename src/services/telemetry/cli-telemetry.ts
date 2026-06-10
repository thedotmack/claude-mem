/**
 * Telemetry capture for the short-lived npx CLI (install / update / uninstall).
 *
 * The worker uses the posthog-node SDK with background batching; a CLI process
 * exits seconds after the event, so instead of bundling the SDK into the npx
 * binary this posts one event directly to the public ingestion endpoint with a
 * hard 2s timeout. Same consent gate, same whitelist scrubber, same anonymous
 * install ID as the worker transport (telemetry.ts).
 */

import { resolveTelemetryConsent, loadTelemetryConfig, getOrCreateInstallId } from './consent.js';
import { scrubProperties } from './scrub.js';
import { getTelemetryApiKey, getTelemetryHost, buildBaseProperties, buildPersonSet } from './common.js';

const CAPTURE_TIMEOUT_MS = 2000;

/**
 * Capture a single CLI event. Resolves when the event is sent, times out, or
 * is skipped (no consent / no key). Never throws, never rejects — an install
 * must finish identically with telemetry unreachable.
 */
export async function captureCliEvent(
  event: string,
  props?: Record<string, unknown>,
  opts?: { person?: boolean }
): Promise<void> {
  try {
    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) {
      return;
    }

    const properties: Record<string, unknown> = scrubProperties({
      ...buildBaseProperties(),
      ...(props ?? {}),
    });
    // Lifecycle events (install_* / uninstall) build the anonymous person
    // profile that powers retention and cohort insights; see telemetry.ts.
    if (opts?.person) {
      properties.$set = buildPersonSet(properties);
    } else {
      properties.$process_person_profile = false;
    }

    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      process.stderr.write('[telemetry] ' + JSON.stringify({ event, properties }) + '\n');
      return;
    }

    const apiKey = getTelemetryApiKey();
    if (!apiKey) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    try {
      // Deliberately no $geoip_disable: the raw capture API geolocates from
      // the request IP at ingest (coarse country/region/city; the IP itself is
      // discarded), matching the worker transport (telemetry.ts).
      await fetch(`${getTelemetryHost()}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          event,
          distinct_id: getOrCreateInstallId(),
          properties,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never break or slow the CLI. Swallow everything.
  }
}
