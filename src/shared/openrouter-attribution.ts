// SPDX-License-Identifier: Apache-2.0

/**
 * Shared OpenRouter app-attribution headers.
 *
 * OpenRouter builds its public app leaderboard from these headers. claude-mem
 * has one entry there (app id 2605040) and both providers — the worker-runtime
 * one (src/services/worker/OpenRouterProvider.ts) and the server-runtime one
 * (src/server/generation/providers/OpenRouterObservationProvider.ts) — must
 * send identical values, or the same product splits into two apps and the
 * ranking splits with it.
 *
 * THE APP'S IDENTITY IS THE REFERER URL, NOT THE TITLE. OpenRouter's docs:
 * "Your app's URL becomes its unique identifier in the system." Changing the
 * title keeps the accumulated ranking; changing the URL mints a brand-new app
 * and strands every token the old one earned. So APP_TITLE is safe to edit and
 * APP_URL is not — do not "tidy" it to the marketing domain.
 *
 * The cmem.ai Pro gateway sends these same values on the user's behalf when a
 * subscriber's traffic is proxied, so gateway and bring-your-own-key traffic
 * land under one entry (claude-mem-pro
 * src/app/api/inference/v1/chat/completions/route.ts).
 */

/** The app's unique identifier on OpenRouter. Changing this resets the ranking. */
export const OPENROUTER_APP_URL = 'https://github.com/thedotmack/claude-mem';

/** Display name only — safe to change, does not affect ranking. */
export const OPENROUTER_APP_TITLE = 'Claude-Mem';

/**
 * Marketplace categories. Max 2 per request, 10 per app. OpenRouter drops
 * unrecognized values silently, so these must come from its published list.
 */
export const OPENROUTER_APP_CATEGORIES = 'cli-agent,programming-app';

/**
 * Attribution headers for an OpenRouter chat-completions request.
 *
 * `siteUrl` and `appName` come from CLAUDE_MEM_OPENROUTER_SITE_URL /
 * CLAUDE_MEM_OPENROUTER_APP_NAME. A user who sets them is deliberately
 * attributing their own traffic elsewhere; blank/unset falls back to ours.
 *
 * X-OpenRouter-Title is the canonical header name. X-Title is still accepted
 * as a back-compat alias, but new code should send the canonical one.
 */
export function openRouterAttributionHeaders(
  siteUrl?: string,
  appName?: string
): Record<string, string> {
  return {
    'HTTP-Referer': siteUrl || OPENROUTER_APP_URL,
    'X-OpenRouter-Title': appName || OPENROUTER_APP_TITLE,
    'X-OpenRouter-Categories': OPENROUTER_APP_CATEGORIES,
  };
}
