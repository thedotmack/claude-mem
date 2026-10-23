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
import type { PaidSendBudget } from './paid-send-budget.js';
import { resolveLlmTimeoutMs } from './retry.js';

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
    || lower.includes('reasoning is required')
    || lower.includes('requires reasoning');
}

/**
 * A 400/422 that names `reasoning` as a field the schema does not have.
 * Only that shape is stripped and retried. "unsupported", "invalid
 * parameter", and "requires reasoning" are value or policy refusals: a model
 * that will not disable reasoning must not have the field forgotten for
 * every later request to that URL.
 */
export function isUnknownReasoningParameter(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes('reasoning')) return false;
  if (isMandatoryReasoningRejection(lower)) return false;
  // "unsupported parameter" is OpenAI's unknown-field wording. A bare
  // "unsupported" is not: "unsupported reasoning effort" is a value refusal.
  return /unknown (?:parameter|field|argument)|unrecognized (?:parameter|field|argument)|unexpected (?:parameter|field|argument)|unsupported parameter|extra fields?|additional propert|not permitted/.test(lower);
}

export function reasoningBudgetRetryMessage(label: string): string {
  return `${label} reply was empty because reasoning consumed the output budget; retrying with reasoning disabled`;
}

export function reasoningBudgetGiveUpMessage(label: string, finishReason: string | undefined): string {
  return `${label} reply was empty with finish_reason=${finishReason ?? 'unknown'} even though reasoning was disabled; reasoning consumed the output budget and the model ignored the flag or reasoning is mandatory, so this turn stores no observations`;
}

/** The batch already used its paid-send allowance, so the reasoning retry is not bought. */
export function reasoningBudgetSkippedMessage(label: string, spentPaidSends: number): string {
  return `${label} reply was empty because reasoning consumed the output budget; not retrying because this batch already made ${spentPaidSends} paid sends, so this turn stores no observations`;
}

/**
 * One more paid send for the reasoning-off retry, counted on the same budget
 * withRetry already charged for this batch. False when the allowance is spent:
 * the caller logs and keeps the empty reply instead of buying another request.
 * No budget (an init turn) still allows the single retry.
 */
export function claimReasoningBudgetRetry(budget: PaidSendBudget | undefined): boolean {
  if (budget && !budget.hasRemainingPaidSend()) return false;
  budget?.recordPaidSend();
  return true;
}

/**
 * The same per-attempt deadline withRetry arms. A reasoning retry that runs
 * outside that loop used to pass a signal nothing ever aborted.
 */
export function startReasoningRetryDeadline(
  external: AbortSignal | undefined,
  perAttemptTimeoutMs?: number,
): { signal: AbortSignal; finish(): void } {
  const controller = new AbortController();
  const timeoutMs = perAttemptTimeoutMs ?? resolveLlmTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternal = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onExternal, { once: true });
  return {
    signal: controller.signal,
    finish() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    },
  };
}

export interface BilledChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left !== 'number' && typeof right !== 'number') return undefined;
  return (typeof left === 'number' ? left : 0) + (typeof right === 'number' ? right : 0);
}

/**
 * Context size is the retry's prompt (the conversation we kept). Billed output
 * and cost add both requests: the empty length reply was paid for too.
 * totalTokens follows that split when both sides exist, so it does not count
 * the first prompt a second time.
 */
export function combineBilledChatUsage(
  first: BilledChatUsage | undefined,
  retry: BilledChatUsage | undefined,
): BilledChatUsage {
  const promptTokens = typeof retry?.promptTokens === 'number' ? retry.promptTokens : first?.promptTokens;
  const completionTokens = sumDefined(first?.completionTokens, retry?.completionTokens);
  const totalTokens = typeof promptTokens === 'number' && typeof completionTokens === 'number'
    ? promptTokens + completionTokens
    : sumDefined(first?.totalTokens, retry?.totalTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: sumDefined(first?.costUsd, retry?.costUsd),
  };
}

export interface BilledGeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/** Gemini's split of {@link combineBilledChatUsage}: last prompt, both answers and both thought counts. */
export function combineBilledGeminiUsage(
  first: BilledGeminiUsage | undefined,
  retry: BilledGeminiUsage | undefined,
): BilledGeminiUsage {
  const promptTokenCount = typeof retry?.promptTokenCount === 'number' ? retry.promptTokenCount : first?.promptTokenCount;
  const candidatesTokenCount = sumDefined(first?.candidatesTokenCount, retry?.candidatesTokenCount);
  const thoughtsTokenCount = sumDefined(first?.thoughtsTokenCount, retry?.thoughtsTokenCount);
  const hasOutput = typeof candidatesTokenCount === 'number' || typeof thoughtsTokenCount === 'number';
  const totalTokenCount = typeof promptTokenCount === 'number' && hasOutput
    ? promptTokenCount + (candidatesTokenCount ?? 0) + (thoughtsTokenCount ?? 0)
    : sumDefined(first?.totalTokenCount, retry?.totalTokenCount);
  return { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount };
}

/**
 * Tokens a server job should meter after a reasoning retry. Unlike the worker,
 * the server has one billed quantity and no context-size counter, so both
 * requests' totals are added (each prompt was sent and billed).
 */
export function billedTokensAcrossRetry(
  first: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  retry: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): number | undefined {
  const totalOf = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined) => {
    if (typeof usage?.total_tokens === 'number') return usage.total_tokens;
    return sumDefined(usage?.prompt_tokens, usage?.completion_tokens);
  };
  return sumDefined(totalOf(first), totalOf(retry));
}
