// SPDX-License-Identifier: Apache-2.0

/**
 * Reasoning models count their thinking against max_tokens. When the whole
 * budget is spent thinking, the reply is empty content with finish_reason
 * "length" (Gemini: MAX_TOKENS) and the observer stores nothing (#2995).
 *
 * The safe request is reasoning off. A length-truncated empty reply is a
 * failure: log it and retry once with reasoning forced off. A finish_reason
 * of "stop" with an empty body is a different case (#3569) and stays a
 * non-error.
 */

import { logger } from '../../utils/logger.js';

export const REASONING_DISABLED: { enabled: false } = { enabled: false };

/** '' | off | false | disabled | none → off. on | true | enabled → on. Anything else is invalid. */
export function parseOpenAICompatReasoning(raw: unknown): 'off' | 'on' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '' || value === 'off' || value === 'false' || value === 'disabled' || value === 'none') return 'off';
  if (value === 'on' || value === 'true' || value === 'enabled') return 'on';
  return undefined;
}

let lastWarnedCompatReasoning: string | null = null;

/**
 * The openai-compatible reasoning mode. Empty and the off aliases disable
 * reasoning. An unrecognized value warns once and disables too: an install
 * that cannot say "on" must not silently burn the output budget.
 */
export function resolveOpenAICompatReasoning(raw: unknown): 'off' | 'on' {
  const parsed = parseOpenAICompatReasoning(raw);
  if (parsed) return parsed;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text && lastWarnedCompatReasoning !== text) {
    lastWarnedCompatReasoning = text;
    logger.warn('SDK', `Ignoring CLAUDE_MEM_OPENAI_COMPAT_REASONING "${text}": use "off" (default) or "on"`);
  }
  return 'off';
}

/** Empty (or whitespace) assistant text cut off by the output cap. "stop" is not this. */
export function isLengthTruncatedEmptyReply(content: string | null | undefined, finishReason: string | undefined): boolean {
  if (typeof content === 'string') {
    if (content.trim() !== '') return false;
  } else if (content != null) {
    return false;
  }
  const reason = (finishReason ?? '').trim().toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
}

/** The request already asked the model not to reason (OpenRouter's enabled:false, or effort "none"). */
export function requestDisablesReasoning(body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) return false;
  const record = reasoning as { enabled?: unknown; effort?: unknown };
  return record.enabled === false || record.effort === 'none';
}

export function reasoningTokenCount(usage: { completion_tokens_details?: { reasoning_tokens?: unknown }; reasoning_tokens?: unknown } | undefined): number | undefined {
  const detailed = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof detailed === 'number') return detailed;
  return typeof usage?.reasoning_tokens === 'number' ? usage.reasoning_tokens : undefined;
}

const endpointsThatRejectReasoningField = new Set<string>();

export function endpointRejectsReasoningField(url: string): boolean {
  return endpointsThatRejectReasoningField.has(url);
}

/** Remember a URL whose schema rejects `reasoning`. True the first time. */
export function rememberEndpointRejectsReasoningField(url: string): boolean {
  if (endpointsThatRejectReasoningField.has(url)) return false;
  endpointsThatRejectReasoningField.add(url);
  return true;
}

export function resetReasoningFieldRejectionsForTesting(): void {
  endpointsThatRejectReasoningField.clear();
  lastWarnedCompatReasoning = null;
}

function isMandatoryReasoningRejection(lower: string): boolean {
  return lower.includes('mandatory')
    || lower.includes('cannot be disabled')
    || lower.includes('cannot disable')
    || lower.includes('does not support none')
    || lower.includes('reasoning is required');
}

/**
 * A 400/422 that names `reasoning` as an unknown field. A model that refuses
 * to disable reasoning (mandatory) is not this: stripping the field and
 * resending would hide that refusal.
 */
export function isUnknownReasoningParameter(text: string): boolean {
  const lower = text.toLowerCase();
  if (isMandatoryReasoningRejection(lower)) return false;
  if (!lower.includes('reasoning')) return false;
  return /unknown|unsupported|unrecognized|unexpected|extra field|additional propert|not permitted|invalid parameter/.test(lower);
}

export function reasoningBudgetRetryMessage(label: string): string {
  return `${label} reply was empty because reasoning consumed the output budget; retrying with reasoning disabled`;
}

export function reasoningBudgetGiveUpMessage(label: string, finishReason: string | undefined): string {
  return `${label} reply was empty with finish_reason=${finishReason ?? 'unknown'} even though reasoning was disabled; reasoning consumed the output budget and the model ignored the flag or reasoning is mandatory, so this turn stores no observations`;
}
