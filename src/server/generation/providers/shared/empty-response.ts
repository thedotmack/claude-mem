// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../../utils/logger.js';
import type { ServerGenerationResult } from './types.js';

// Some gateway models (for example DeepSeek v4-flash) run hidden thinking that
// counts toward the output-token budget. When the whole budget is spent on
// reasoning, the API returns HTTP 200 with a truncation stop reason and EMPTY
// text, so the observation is silently lost (#3630). The provider detects that
// case and retries once with a larger budget instead of dropping the
// observation. This module holds the shared budget and stop-reason logic so
// every REST provider behaves the same way.

// Floor for the one-shot retry budget. A gateway that blanks at a small budget
// needs real headroom on the retry, so the retry budget is at least this value.
export const EMPTY_RESPONSE_RETRY_MIN_BUDGET = 8192;

// The one-shot retry budget: double the current budget, but never below the
// floor above.
export function nextRetryBudget(currentBudget: number): number {
  return Math.max(currentBudget * 2, EMPTY_RESPONSE_RETRY_MIN_BUDGET);
}

// Truncation markers across the response shapes we support:
//   Anthropic  stop_reason   = "max_tokens"
//   OpenAI     finish_reason = "length"
//   Gemini     finishReason  = "MAX_TOKENS"
export function isTruncationStopReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return lower === 'max_tokens' || lower === 'length';
}

// Retry only when the text is empty AND the model reported that it hit the
// budget. A genuine completion (end_turn / stop / STOP) with empty text will not
// be fixed by a larger budget, and an absent stop reason (content filtered,
// choice-less / candidate-less response) is not a confirmed truncation — a retry
// in either case would just waste a billed call.
export function shouldRetryEmptyResponse(rawText: string, reason: string | null | undefined): boolean {
  return rawText.length === 0 && isTruncationStopReason(reason);
}

// The raw shape a provider extracts from one HTTP response, before it is turned
// into a ServerGenerationResult. `stopReason` is the vendor's own field
// (Anthropic `stop_reason`, OpenAI `finish_reason`, Gemini `finishReason`).
export interface RawGenerationResult {
  rawText: string;
  tokensUsed?: number;
  stopReason?: string;
}

// Shared retry shell for the REST providers: issue one request, and if the text
// came back empty because the budget was exhausted, retry once with a larger
// budget before giving up. `request` receives the budget to use so the retry
// can pass a bigger one. The per-provider response parsing stays in `request`;
// only the retry policy and result shaping live here.
export async function generateWithEmptyResponseRetry(
  params: { providerLabel: ServerGenerationResult['providerLabel']; modelId: string; maxOutputTokens: number },
  request: (maxOutputTokens: number) => Promise<RawGenerationResult>,
): Promise<ServerGenerationResult> {
  const { providerLabel, modelId, maxOutputTokens } = params;

  let result = await request(maxOutputTokens);

  if (shouldRetryEmptyResponse(result.rawText, result.stopReason)) {
    const retryBudget = nextRetryBudget(maxOutputTokens);
    logger.warn('SDK', `${providerLabel} returned empty text; retrying once with a larger token budget`, {
      provider: providerLabel,
      model: modelId,
      stopReason: result.stopReason ?? null,
      budget: maxOutputTokens,
      retryBudget,
    });
    result = await request(retryBudget);
  }

  if (!result.rawText) {
    logger.warn('SDK', `${providerLabel} returned empty content`, {
      provider: providerLabel,
      model: modelId,
      stopReason: result.stopReason ?? null,
    });
  }

  return {
    rawText: result.rawText,
    ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
    providerLabel,
    modelId,
  };
}
