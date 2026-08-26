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
 * staging backend without a rebuild; production is the compiled-in default, so
 * no staging host is ever baked into a shipped artifact.
 */

/** aimlapi.com's OpenAI-compatible surface. `/v2` on this host is billing-only. */
export const AIMLAPI_DEFAULT_BASE_URL = 'https://api.aimlapi.com/v1';
export const DEFAULT_AIMLAPI_API_URL = `${AIMLAPI_DEFAULT_BASE_URL}/chat/completions`;

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Resolve the chat-completions endpoint from an optional configured base URL.
 *
 * Rules mirror the OpenRouter resolver so the two providers behave identically
 * for anyone who has configured one already:
 *   - unset/blank -> the default aimlapi.com chat-completions URL
 *   - a full URL already ending in `/chat/completions` -> used verbatim
 *   - a base URL (e.g. `https://api.aimlapi.com/v1`) -> `/chat/completions` appended
 *   - trailing slashes are normalized before matching/appending
 */
export function resolveAimlapiChatCompletionsUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_AIMLAPI_API_URL;
  }

  const normalized = trimmed.replace(/\/+$/, '');

  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }

  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
