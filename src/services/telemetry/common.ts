/**
 * Constants and base properties shared by the two telemetry transports:
 * the worker-resident posthog-node client (telemetry.ts) and the short-lived
 * CLI direct-POST capture (cli-telemetry.ts).
 */

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

export function buildBaseProperties(): Record<string, unknown> {
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
