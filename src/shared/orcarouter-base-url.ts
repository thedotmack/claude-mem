// SPDX-License-Identifier: Apache-2.0

/**
 * Shared base-URL resolution for the OpenAI-compatible OrcaRouter provider.
 *
 * Both the worker-runtime provider (src/services/worker/OrcaRouterProvider.ts)
 * and the server-runtime provider
 * (src/server/generation/providers/OrcaRouterObservationProvider.ts) use this
 * to turn the optional CLAUDE_MEM_ORCAROUTER_BASE_URL setting into a concrete
 * `/chat/completions` endpoint. This makes the OrcaRouter client a generic
 * OpenAI-compatible client — same resolution rules as the OpenRouter client
 * (src/shared/openrouter-base-url.ts).
 *
 * OrcaRouter exposes the Anthropic Messages protocol at https://api.orcarouter.ai/v1
 * and an OpenAI-compatible chat-completions surface at https://api.orcarouter.ai/v1/chat/completions.
 *
 * Usage examples (set CLAUDE_MEM_PROVIDER=orcarouter, then):
 *
 *   OrcaRouter default:
 *     CLAUDE_MEM_ORCAROUTER_BASE_URL = https://api.orcarouter.ai/v1
 *     CLAUDE_MEM_ORCAROUTER_MODEL    = anthropic/claude-haiku-4.5
 *     ORCAROUTER_API_KEY (in ~/.claude-mem/.env) = <orcarouter key>
 *
 *   Generic OpenAI-compatible endpoint:
 *     CLAUDE_MEM_ORCAROUTER_BASE_URL = https://my-gateway.example.com/v1
 *     CLAUDE_MEM_ORCAROUTER_MODEL    = <model id>
 */

export const DEFAULT_ORCAROUTER_API_URL = 'https://api.orcarouter.ai/v1/chat/completions';

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Resolve the chat-completions endpoint from an optional configured base URL.
 *
 * Rules:
 *   - unset/blank  -> default OrcaRouter chat-completions URL (behavior unchanged)
 *   - a full URL already ending in `/chat/completions` -> used verbatim
 *   - a base URL (e.g. `https://api.orcarouter.ai/v1`) -> `/chat/completions` appended
 *   - trailing slashes are normalized before matching/appending
 */
export function resolveOrcaRouterChatCompletionsUrl(baseUrl: string | undefined | null): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_ORCAROUTER_API_URL;
  }

  // Normalize trailing slashes so `.../v1/` and `.../v1` behave identically.
  const normalized = trimmed.replace(/\/+$/, '');

  if (normalized.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return normalized;
  }

  return `${normalized}${CHAT_COMPLETIONS_PATH}`;
}
