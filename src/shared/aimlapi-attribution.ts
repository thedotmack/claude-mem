// SPDX-License-Identifier: Apache-2.0

/**
 * Shared aimlapi.com attribution headers.
 *
 * aimlapi.com expects this pair on every request it serves. It marks the
 * traffic as agent-originated and attributes it to the claude-mem integration.
 *
 * Both runtimes — the worker one (src/services/worker/AimlapiProvider.ts) and
 * the server one (src/server/generation/providers/AimlapiObservationProvider.ts)
 * — build their headers here, so they always send identical values.
 *
 * The headers go to aimlapi.com and nowhere else. CLAUDE_MEM_AIMLAPI_BASE_URL
 * can point the provider at another host (a staging backend, a proxy); the
 * attribution pair, the referer and the title are then left off, the same rule
 * the openai-compatible provider follows for OpenRouter's headers
 * (src/shared/openai-compat-presets.ts). `aimlapiRequestHeaders` is the one
 * place that decides, so no call site can forget.
 *
 * Unlike OpenRouter's HTTP-Referer, the partner id is NOT a user-facing knob:
 * it identifies the integration, not the installation, so it is deliberately
 * not wired to a CLAUDE_MEM_* setting.
 */

/** The client half of `<channel>/<client>`: this integration's registry slug. */
export const AIMLAPI_SOURCE = 'agent/claude-mem';

/**
 * Partner id for the claude-mem integration. The same id is valid on
 * aimlapi.com's staging and production backends, so it ships compiled in.
 */
export const AIMLAPI_PARTNER_ID = 'part_Ilh1LOkwr8LXpT9Cgd8dTVyA';

/** The app's public identity, sent as HTTP-Referer. Informational only. */
export const AIMLAPI_APP_URL = 'https://github.com/thedotmack/claude-mem';

/** Display name sent as X-Title. */
export const AIMLAPI_APP_TITLE = 'Claude-Mem';

/** True for aimlapi.com and its subdomains (api.aimlapi.com), over https only. */
export function isAimlapiHost(url: string | undefined | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL((url ?? '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'aimlapi.com' || host.endsWith('.aimlapi.com');
}

/**
 * Attribution headers for an aimlapi.com chat-completions request.
 *
 * `siteUrl` and `appName` come from CLAUDE_MEM_AIMLAPI_SITE_URL /
 * CLAUDE_MEM_AIMLAPI_APP_NAME; a user who sets them is relabelling their own
 * traffic, which is harmless. The source/partner pair is NOT user-settable.
 */
export function aimlapiAttributionHeaders(
  siteUrl?: string,
  appName?: string
): Record<string, string> {
  return {
    'X-AIMLAPI-Source': AIMLAPI_SOURCE,
    'X-AIMLAPI-Partner-ID': AIMLAPI_PARTNER_ID,
    'HTTP-Referer': siteUrl || AIMLAPI_APP_URL,
    'X-Title': appName || AIMLAPI_APP_TITLE,
  };
}

/**
 * The attribution headers for a request to `apiUrl`: the full set when it is
 * aimlapi.com, nothing at all for any other host.
 */
export function aimlapiRequestHeaders(
  apiUrl: string,
  siteUrl?: string,
  appName?: string
): Record<string, string> {
  return isAimlapiHost(apiUrl) ? aimlapiAttributionHeaders(siteUrl, appName) : {};
}
