/**
 * Constants and base properties shared by the two telemetry transports:
 * the worker-resident posthog-node client (telemetry.ts) and the short-lived
 * CLI direct-POST capture (cli-telemetry.ts).
 */

import os from 'os';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion =
  typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

/**
 * Publishable PostHog project token (phc_...). Publishable tokens are safe to
 * embed: the capture endpoints are public POST-only ingestion.
 * `CLAUDE_MEM_TELEMETRY_KEY` always overrides this constant.
 */
export const TELEMETRY_PUBLIC_KEY = 'phc_BKJAeNbpj932N9qEiU6qhutZEiu6LLfRpXfTbLM9MLaG';

export const DEFAULT_TELEMETRY_HOST = 'https://us.i.posthog.com';

export function getTelemetryApiKey(): string {
  return process.env.CLAUDE_MEM_TELEMETRY_KEY || TELEMETRY_PUBLIC_KEY;
}

export function getTelemetryHost(): string {
  return process.env.CLAUDE_MEM_TELEMETRY_HOST || DEFAULT_TELEMETRY_HOST;
}

/**
 * Whitelisted properties that may also be set as PostHog person properties on
 * lifecycle events (install_*, worker_started). The "person" is the anonymous
 * install UUID — these traits make retention/cohort insights sliceable by
 * platform and product choices. Strict subset of the scrub whitelist.
 */
export const PERSON_PROPERTY_KEYS = [
  'version',
  'os',
  'os_version',
  'is_wsl',
  'arch',
  'runtime',
  'locale',
  'ide',
  'provider',
  'runtime_mode',
  'install_method',
  'claude_code_version',
  // Install snapshot (refreshed by the daily worker_started heartbeat) —
  // lets cohorts slice by install scale, age, and activity.
  'db_observation_count',
  'db_session_count',
  'db_summary_count',
  'db_project_count',
  'db_size_mb',
  'install_age_days',
  'obs_count_7d',
  'obs_count_30d',
  'days_since_last_obs',
] as const;

/**
 * Splits already-scrubbed properties into a $set object for person-profile
 * events. Lifecycle events are low-volume (~1-2/day/install), so the
 * person-profile ingestion cost is bounded while unlocking PostHog's native
 * retention, stickiness, lifecycle, and cohort insights.
 */
export function buildPersonSet(
  scrubbed: Record<string, unknown>
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const key of PERSON_PROPERTY_KEYS) {
    if (scrubbed[key] !== undefined) set[key] = scrubbed[key];
  }
  return set;
}

/**
 * Kernel release (`os.release()`): "10.0.22631" distinguishes Win10/Win11
 * builds, Darwin major maps to the macOS release, Linux gives the kernel.
 * System metadata only — never user data.
 */
function detectOsVersion(): string {
  try {
    return os.release();
  } catch {
    return 'unknown';
  }
}

function detectWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

export function buildBaseProperties(): Record<string, unknown> {
  return {
    version: packageVersion,
    os: process.platform,
    os_version: detectOsVersion(),
    is_wsl: detectWsl(),
    arch: process.arch,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtime_version: process.versions.bun ?? process.versions.node,
    node_version: process.versions.node,
    is_ci: Boolean(process.env.CI),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}
