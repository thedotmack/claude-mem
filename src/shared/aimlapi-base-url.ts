// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base-URL resolution for the aimlapi.com provider.
 *
 * Both the worker-runtime provider (src/services/worker/AimlapiProvider.ts) and
 * the server-runtime provider
 * (src/server/generation/providers/AimlapiObservationProvider.ts) use this to
 * turn the optional CLAUDE_MEM_AIMLAPI_BASE_URL setting into a concrete
 * `/chat/completions` endpoint.
 *
 * The override exists so the same build can be pointed at aimlapi.com's
 * staging backend without a rebuild; production is the compiled-in default.
 */

import { resolveOpenRouterChatCompletionsUrl } from './openrouter-base-url.js';
import { getCredential } from './EnvManager.js';

/** aimlapi.com's OpenAI-compatible surface. `/v2` on this host is billing-only. */
export const AIMLAPI_DEFAULT_BASE_URL = 'https://api.aimlapi.com/v1';

/**
 * Default observation model. One constant shared by the worker provider, the
 * server provider and the settings defaults so they can never disagree.
 */
export const AIMLAPI_DEFAULT_MODEL = 'openai/gpt-5.6-terra';
export const DEFAULT_AIMLAPI_API_URL = `${AIMLAPI_DEFAULT_BASE_URL}/chat/completions`;

/**
 * Resolve the chat-completions endpoint from an optional configured base URL:
 * blank means the default aimlapi.com URL; anything else goes through the
 * shared OpenAI-compatible normalizer (trailing slashes, a base that already
 * names `/chat/completions`, query strings).
 */
export function resolveAimlapiChatCompletionsUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? '').trim();
  return trimmed ? resolveOpenRouterChatCompletionsUrl(trimmed) : DEFAULT_AIMLAPI_API_URL;
}

/**
 * The aimlapi.com key, from the first place that has one:
 *  1. CLAUDE_MEM_AIMLAPI_API_KEY (settings.json, or the same name in the
 *     process environment, which SettingsDefaultsManager already applies);
 *  2. AIMLAPI_API_KEY in the process environment, the documented deployment
 *     credential and the name the server runtime reads;
 *  3. AIMLAPI_API_KEY in ~/.claude-mem/.env.
 */
export function resolveAimlapiApiKey(settings: { CLAUDE_MEM_AIMLAPI_API_KEY?: unknown }): string {
  const configured = typeof settings.CLAUDE_MEM_AIMLAPI_API_KEY === 'string' ? settings.CLAUDE_MEM_AIMLAPI_API_KEY.trim() : '';
  return configured
    || (process.env.AIMLAPI_API_KEY ?? '').trim()
    || (getCredential('AIMLAPI_API_KEY') ?? '').trim();
}
