/**
 * Telemetry capture for the short-lived npx CLI (install / update / uninstall).
 *
 * The worker uses the posthog-node SDK with background batching; a CLI process
 * exits seconds after the event, so instead of bundling the SDK into the npx
 * binary this posts one event directly to the public ingestion endpoint with a
 * hard 2s timeout. Same consent gate, same whitelist scrubber, same anonymous
 * install ID as the worker transport (telemetry.ts).
 */

import { resolveTelemetryConsent, loadTelemetryConfig, getOrCreateInstallId, getOrCreateAnonymousDistinctId } from './consent.js';
import { scrubProperties } from './scrub.js';
import { getTelemetryApiKey, getTelemetryHost, buildBaseProperties, buildPersonSet } from './common.js';
import { observeTelemetryVolume } from './daily-volume.js';

const CAPTURE_TIMEOUT_MS = 2000;

/**
 * Capture a single CLI event. Resolves when the event is sent, times out, or
 * is skipped (no consent / no key). Never throws, never rejects — an install
 * must finish identically with telemetry unreachable.
 */
export async function captureCliEvent(
  event: string,
  props?: Record<string, unknown>,
  opts?: { person?: boolean; bypassVolume?: boolean }
): Promise<void> {
  try {
    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) {
      return;
    }

    const properties: Record<string, unknown> = scrubProperties({
      ...buildBaseProperties(),
      ...(props ?? {}),
    });
    if (!opts?.bypassVolume) {
      const decision = observeTelemetryVolume(event, properties);
      for (const closed of decision.closed) {
        await postCaptureEvent(getTelemetryApiKey(), closed.event, {
          ...closed.properties,
          $process_person_profile: false,
        }, AbortSignal.timeout(CAPTURE_TIMEOUT_MS), getOrCreateAnonymousDistinctId());
      }
      if (!decision.forward) return;
    }
    // Install / uninstall events build the anonymous person profile that
    // powers retention and cohort insights. Worker and plugin events do not:
    // `$set` on the install id makes every later event for that id bill as
    // identified. See telemetry.ts.
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    try {
      await postCaptureEvent(
        apiKey,
        event,
        properties,
        controller.signal,
        opts?.person ? getOrCreateInstallId() : getOrCreateAnonymousDistinctId(),
      );
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never break or slow the CLI. Swallow everything.
  }
}

/**
 * POST one event to the public ingestion endpoint.
 *
 * Deliberately no $geoip_disable: the raw capture API geolocates from the
 * request IP at ingest (coarse country/region/city; the IP itself is
 * discarded), matching the worker transport (telemetry.ts).
 */
async function postCaptureEvent(
  apiKey: string,
  event: string,
  properties: Record<string, unknown>,
  signal: AbortSignal,
  distinctId: string,
): Promise<void> {
  await fetch(`${getTelemetryHost()}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      event,
      distinct_id: distinctId,
      properties,
    }),
    signal,
  });
}
