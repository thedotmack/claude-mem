// SPDX-License-Identifier: Apache-2.0

/**
 * CLAUDE_MEM_OPENROUTER_EXTRA_BODY: provider-specific request fields merged
 * into every OpenRouter-provider request, such as `{"reasoning":{"enabled":false}}`
 * or `{"thinking":{"type":"disabled"}}` for a reasoning model that otherwise
 * spends the output budget thinking and answers with nothing (#2995).
 *
 * Shared by the worker (OpenRouterProvider) and the server runtime
 * (OpenRouterObservationProvider), so the two apply the same rules:
 *  - it is a JSON object, or it is ignored with a warning — it is read during
 *    status polling, so a typo must never throw;
 *  - it never replaces the fields that carry the conversation, the model
 *    routing, streaming or the output cap (PROTECTED_EXTRA_BODY_KEYS);
 *  - it is never sent to the cmem gateway, which sets its own request policy
 *    on traffic it pays for.
 */

import { isCmemGatewayUrl } from './cmem-gateway.js';

/**
 * Fields the extra body can never set. `max_tokens` is the observer output cap
 * (CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS) that the #4003 retry reads back as
 * `max_completion_tokens`; `stream` / `stream_options` decide how the reply is
 * read and whether it carries usage.
 */
export const PROTECTED_EXTRA_BODY_KEYS: readonly string[] = [
  'model',
  'models',
  'messages',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
];

/** A Telegram wrap-up's own output controls, which the extra body never overrides. */
const PLAIN_TEXT_KEYS: readonly string[] = ['reasoning', 'response_format'];

export interface ParsedExtraBody {
  /** The usable fields, protected keys removed; undefined when unset or invalid. */
  extraBody?: Record<string, unknown>;
  /** Why the setting was ignored or trimmed, for a one-time warning. */
  warning?: string;
}

/**
 * Parse the setting: an object written straight into settings.json, or a
 * string holding one (an environment variable is always a string). Never
 * throws.
 */
export function parseOpenRouterExtraBody(raw: unknown): ParsedExtraBody {
  let parsed: unknown = raw;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      parsed = JSON.parse(text);
    } catch {
      return { warning: 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY is not valid JSON; ignoring it' };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { warning: 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY must be a JSON object; ignoring it' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const dropped = entries.map(([key]) => key).filter(key => PROTECTED_EXTRA_BODY_KEYS.includes(key));
  const extraBody = Object.fromEntries(entries.filter(([key]) => !PROTECTED_EXTRA_BODY_KEYS.includes(key)));
  return {
    ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
    ...(dropped.length > 0
      ? { warning: `CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot set ${dropped.join(', ')}; ignoring ${dropped.length === 1 ? 'that field' : 'those fields'}` }
      : {}),
  };
}

/**
 * The request body with the extra fields merged over it: they may override
 * ordinary fields such as `temperature` or add vendor ones, but never a
 * protected field, never a wrap-up's output controls, and never on the way to
 * the cmem gateway.
 */
export function withOpenRouterExtraBody(
  body: Record<string, unknown>,
  extraBody: Record<string, unknown> | undefined,
  apiUrl: string,
  plainText: boolean = false,
): Record<string, unknown> {
  if (!extraBody || isCmemGatewayUrl(apiUrl)) return body;
  const merged = { ...body };
  for (const [key, value] of Object.entries(extraBody)) {
    if (PROTECTED_EXTRA_BODY_KEYS.includes(key)) continue;
    if (plainText && PLAIN_TEXT_KEYS.includes(key)) continue;
    merged[key] = value;
  }
  return merged;
}
