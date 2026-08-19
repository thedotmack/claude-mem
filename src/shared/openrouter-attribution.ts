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
 * Marketplace categories. OpenRouter accepts at most 2 per request but stores
 * up to 10 per app, so a request sends one PAIR and the app accumulates the
 * union over time. That is the only way to hold more than two.
 *
 * Why these four:
 *   cli-agent          — what claude-mem is; the crowded headline category.
 *   ide-extension      — it ships as a plugin to agent harnesses.
 *   writing-assistant  — the observation/digest workload is prose generation.
 *   creative-writing   — the narrative reports (timeline, weekly digests).
 *
 * Deliberately NOT claimed: video-gen / image-gen / audio-gen (claude-mem
 * generates no media) and roleplay / game. Those would rank well precisely
 * because they are uncontested, which is the tell that they would be false.
 *
 * OpenRouter drops unrecognized values silently — a typo costs the category
 * with no error — so these are checked against its published list in
 * tests/shared/openrouter-attribution.test.ts.
 */
export const OPENROUTER_APP_CATEGORY_PAIRS = [
  'cli-agent,ide-extension',
  'writing-assistant,creative-writing',
] as const;

/**
 * Pick the pair for one request.
 *
 * Random, not a rotating counter: the cmem.ai gateway runs serverless, where a
 * per-process counter restarts at 0 on every cold start and would send the
 * first pair almost exclusively — the later categories would never register.
 */
export function pickOpenRouterCategories(): string {
  return OPENROUTER_APP_CATEGORY_PAIRS[
    Math.floor(Math.random() * OPENROUTER_APP_CATEGORY_PAIRS.length)
  ];
}

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
    'X-OpenRouter-Categories': pickOpenRouterCategories(),
  };
}
