// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base-URL resolution for the OpenAI-compatible OpenRouter provider.
 *
 * Both the worker-runtime provider (src/services/worker/OpenRouterProvider.ts)
 * and the server-runtime provider
 * (src/server/generation/providers/OpenRouterObservationProvider.ts) use this
 * to turn the optional CLAUDE_MEM_OPENROUTER_BASE_URL setting into a concrete
 * `/chat/completions` endpoint. This makes the OpenRouter client a generic
 * OpenAI-compatible client.
 *
 * Closes #2382 (CLAUDE_MEM_OPENROUTER_BASE_URL), #2590 (custom provider with
 * configurable API base URL), #2622 (DeepSeek — OpenAI-compatible), and #2393
 * (LM Studio local model — OpenAI-compatible). Combined with the existing
 * CLAUDE_MEM_OPENROUTER_MODEL setting (passed verbatim), a user points the base
 * URL at any OpenAI-compatible endpoint and selects an arbitrary model id.
 *
 * Usage examples (set CLAUDE_MEM_PROVIDER=openrouter, then):
 *
 *   DeepSeek:
 *     CLAUDE_MEM_OPENROUTER_BASE_URL = https://api.deepseek.com
 *     CLAUDE_MEM_OPENROUTER_MODEL    = deepseek-chat
 *     OPENROUTER_API_KEY (in ~/.claude-mem/.env) = <deepseek key>
 *
 *   LM Studio (local, no key required):
 *     CLAUDE_MEM_OPENROUTER_BASE_URL = http://localhost:1234/v1
 *     CLAUDE_MEM_OPENROUTER_MODEL    = <any local model id>
 *
 *   Generic OpenAI-compatible endpoint:
 *     CLAUDE_MEM_OPENROUTER_BASE_URL = https://my-gateway.example.com/v1
 *     CLAUDE_MEM_OPENROUTER_MODEL    = <model id>
 */

export const DEFAULT_OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Resolve the chat-completions endpoint from an optional configured base URL.
 *
 * Rules:
 *   - unset/blank  -> default OpenRouter chat-completions URL (behavior unchanged)
 *   - a full URL already ending in `/chat/completions` -> used verbatim
 *   - a base URL (e.g. `https://api.deepseek.com/v1`) -> `/chat/completions` appended
 *   - trailing slashes are normalized before matching/appending
 */
export function resolveOpenRouterChatCompletionsUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_OPENROUTER_API_URL;
  }

  // Normalize trailing slashes so `.../v1/` and `.../v1` behave identically.
  const normalized = trimmed.replace(/\/+$/, '');

  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }

  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
