// SPDX-License-Identifier: Apache-2.0
//
// Each protocol's usage block as one WireUsage (plan Phase 3 task 4). Ported
// from magpie (MIT, Copyright (c) 2026 yetone): aUsage.usage
// anthropic.go:1227-1250, cUsage.usage chat.go:756-815, rUsage.usage
// responses.go:1200-1220, Gemini usageMetadata sniff.go:136-162, and
// Usage.add ir.go:358-401. inputTokens always means what was neither read
// from nor written to a cache, as Anthropic counts it; OpenAI and Gemini
// count the whole prompt, so their cached tokens are taken off.

import type { WireUsage } from './types.js';

type UsageCounts = Omit<WireUsage, 'deferred'>;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `value` when it is a JSON object, else an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Anthropic `usage` (message_start, message_delta, or a whole message). */
export function anthropicUsage(rawUsage: unknown): Partial<WireUsage> {
  const usage = asRecord(rawUsage);
  const cacheCreation = asRecord(usage.cache_creation);
  const cacheWrite1hTokens = count(cacheCreation.ephemeral_1h_input_tokens);
  const cacheWriteSplitTotal = count(cacheCreation.ephemeral_5m_input_tokens) + cacheWrite1hTokens;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: Math.max(count(usage.cache_creation_input_tokens), cacheWriteSplitTotal),
    cacheWrite1hTokens,
    // output_tokens_details.thinking_tokens (report 07 §2.1); magpie does not read it.
    reasoningTokens: count(asRecord(usage.output_tokens_details).thinking_tokens),
  };
}

/**
 * OpenAI Chat `usage`. prompt_tokens counts cached tokens too, so they are
 * taken off; a relay in front of Claude may send Anthropic's own names,
 * which are counted as Anthropic counts (magpie cUsage.usage).
 */
export function openAiChatUsage(rawUsage: unknown): Partial<WireUsage> {
  const usage = asRecord(rawUsage);
  const promptDetails = asRecord(usage.prompt_tokens_details);
  let cacheReadTokens = count(promptDetails.cached_tokens);
  let cacheWriteTokens = count(promptDetails.cache_write_tokens);
  for (const alternative of [usage.prompt_cache_hit_tokens, usage.cached_tokens]) {
    if (cacheReadTokens === 0) cacheReadTokens = count(alternative);
  }
  const promptTokens = count(usage.prompt_tokens);
  let promptIncludesCache = true;
  if (cacheReadTokens === 0 && cacheWriteTokens === 0) {
    cacheReadTokens = count(usage.cache_read_input_tokens);
    cacheWriteTokens = count(usage.cache_creation_input_tokens);
    promptIncludesCache = promptTokens >= cacheReadTokens + cacheWriteTokens;
  }
  const result: Partial<WireUsage> = {
    inputTokens: promptIncludesCache ? Math.max(promptTokens - cacheReadTokens - cacheWriteTokens, 0) : promptTokens,
    outputTokens: count(usage.completion_tokens),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: count(asRecord(usage.completion_tokens_details).reasoning_tokens),
  };
  const deferred = asRecord(usage.magpie_deferred);
  const deferredPrompt = count(deferred.prompt_tokens);
  const deferredCompletion = count(deferred.completion_tokens);
  if (deferredPrompt + deferredCompletion > 0) {
    const deferredCacheRead = count(deferred.cached_tokens);
    const deferredCacheWrite = count(deferred.cache_write_tokens);
    result.deferred = {
      inputTokens: Math.max(deferredPrompt - deferredCacheRead - deferredCacheWrite, 0),
      outputTokens: deferredCompletion,
      cacheReadTokens: deferredCacheRead,
      cacheWriteTokens: deferredCacheWrite,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
    };
  }
  return result;
}

/** OpenAI Responses `usage`: input_tokens is the whole prompt, cached reads and writes among it. */
export function openAiResponsesUsage(rawUsage: unknown): Partial<WireUsage> {
  const usage = asRecord(rawUsage);
  const inputDetails = asRecord(usage.input_tokens_details);
  const cacheReadTokens = count(inputDetails.cached_tokens);
  const cacheWriteTokens = count(inputDetails.cache_write_tokens);
  return {
    inputTokens: Math.max(count(usage.input_tokens) - cacheReadTokens - cacheWriteTokens, 0),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: count(asRecord(usage.output_tokens_details).reasoning_tokens),
  };
}

/** Gemini `usageMetadata`: thoughts are counted as output and as reasoning. */
export function geminiUsage(rawUsageMetadata: unknown): Partial<WireUsage> {
  const usage = asRecord(rawUsageMetadata);
  const cachedTokens = count(usage.cachedContentTokenCount);
  const thoughtsTokens = count(usage.thoughtsTokenCount);
  return {
    inputTokens: Math.max(count(usage.promptTokenCount) - cachedTokens, 0),
    cacheReadTokens: cachedTokens,
    outputTokens: count(usage.candidatesTokenCount) + thoughtsTokens,
    reasoningTokens: thoughtsTokens,
  };
}

const USAGE_COUNT_KEYS: Array<keyof UsageCounts> = [
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens',
];

/**
 * Merge a later usage report into `target`: each non-zero count replaces the
 * one before (magpie Usage.add). Anthropic's message_delta usage is
 * cumulative, so its last report is the total.
 */
export function mergeWireUsage(target: WireUsage, update: Partial<WireUsage>): void {
  for (const key of USAGE_COUNT_KEYS) {
    const value = update[key];
    if (typeof value === 'number' && value > 0) target[key] = value;
  }
  if (update.deferred) target.deferred = update.deferred;
}
