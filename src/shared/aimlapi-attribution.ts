// SPDX-License-Identifier: Apache-2.0

/**
 * Shared aimlapi.com attribution headers.
 *
 * aimlapi.com expects this pair on EVERY request it serves — inference, model
 * listing and key checks alike, not only sign-up. It marks the traffic as
 * agent-originated and attributes it to the claude-mem integration's partner
 * entry, which is what the aggregator's rebate accounting keys off.
 *
 * Both runtimes — the worker one
 * (src/services/worker/AimlapiProvider.ts) and the server one
 * (src/server/generation/providers/AimlapiObservationProvider.ts) — must send
 * identical values, or the same product is counted as two callers and the
 * attribution splits with it. Keeping the pair in one helper is what makes
 * "every aimlapi.com request is attributed" enforceable in one place instead
 * of re-derived at each call site.
 *
 * Unlike OpenRouter's HTTP-Referer, the partner id is NOT a user-facing knob:
 * it identifies the integration, not the installation, so it is deliberately
 * not wired to a CLAUDE_MEM_* setting.
 */

/** The client half of `<channel>/<client>` — this integration's registry slug. */
export const AIMLAPI_SOURCE = 'agent/claude-mem';

/**
 * Provisioned partner for the claude-mem integration. The same id is valid on
 * aimlapi.com's staging and production backends, so it ships compiled in and a
 * single build works against either — only the base URL differs.
 */
export const AIMLAPI_PARTNER_ID = 'part_Ilh1LOkwr8LXpT9Cgd8dTVyA';

/**
 * The app's public identity, sent as HTTP-Referer for parity with the other
 * gateways. Unlike OpenRouter — where the referer URL IS the app's identity on
 * the leaderboard and changing it strands the accumulated ranking —
 * aimlapi.com attributes by partner id, so this is informational only.
 */
export const AIMLAPI_APP_URL = 'https://github.com/thedotmack/claude-mem';

/** Display name sent for parity with the other gateways' app-title headers. */
export const AIMLAPI_APP_TITLE = 'Claude-Mem';

/**
 * Attribution headers for an aimlapi.com chat-completions request.
 *
 * `siteUrl` and `appName` come from CLAUDE_MEM_AIMLAPI_SITE_URL /
 * CLAUDE_MEM_AIMLAPI_APP_NAME; a user who sets them is relabelling their own
 * traffic, which is harmless. The source/partner pair is NOT user-settable —
 * relabelling those would misattribute the integration itself.
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
