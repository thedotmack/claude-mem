import type { ActiveSession } from '../worker-types.js';

/**
 * Applied only when a gateway reports a bare total with no prompt/completion
 * breakdown. openrouter.ai and Gemini both report the split, so this is the
 * custom-gateway fallback, not the normal path.
 */
const FALLBACK_INPUT_SHARE = 0.7;
const FALLBACK_OUTPUT_SHARE = 0.3;

/** The usage fields an OpenAI-compatible provider response can carry. */
export interface ObserverUsageSample {
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** The subset of the Claude SDK's usage block that feeds the session counters. */
export interface ClaudeUsageSample {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Fold one OpenAI-compatible response into the session's cumulative counters.
 *
 * Gemini (promptTokenCount/candidatesTokenCount) and OpenRouter
 * (prompt_tokens/completion_tokens) both report the real split, so the
 * estimate must not win when real counts exist: the observer resends its whole
 * conversation on every turn, which makes its traffic overwhelmingly
 * input-heavy, and a fixed 70/30 assumption understates input on exactly the
 * long sessions worth noticing. Both sides or nothing, matching buildLastUsage:
 * a gateway reporting only one of the two must not produce a half-real number.
 */
export function accumulateObserverUsage(session: ActiveSession, sample: ObserverUsageSample): void {
  if (typeof sample.inputTokens === 'number' && typeof sample.outputTokens === 'number') {
    session.cumulativeInputTokens += sample.inputTokens;
    session.cumulativeOutputTokens += sample.outputTokens;
    return;
  }

  const total = sample.tokensUsed || 0;
  session.cumulativeInputTokens += Math.floor(total * FALLBACK_INPUT_SHARE);
  session.cumulativeOutputTokens += Math.floor(total * FALLBACK_OUTPUT_SHARE);
}

/**
 * Fold one Claude SDK assistant-message usage block into the session counters.
 *
 * Cache reads are tracked in their own counter rather than added to
 * cumulativeInputTokens: discovery_tokens is derived from the delta of
 * (cumulativeInput + cumulativeOutput) across a response, so widening those two
 * would silently redefine a value already persisted on every observation.
 */
export function accumulateClaudeUsage(session: ActiveSession, usage: ClaudeUsageSample): void {
  session.cumulativeInputTokens += usage.input_tokens || 0;
  session.cumulativeOutputTokens += usage.output_tokens || 0;

  if (usage.cache_creation_input_tokens) {
    session.cumulativeInputTokens += usage.cache_creation_input_tokens;
  }

  if (usage.cache_read_input_tokens) {
    session.cumulativeCacheReadTokens =
      (session.cumulativeCacheReadTokens ?? 0) + usage.cache_read_input_tokens;
  }
}

/**
 * Log context for the once-per-session lines that report what the observer
 * spent. Cache reads are omitted when the provider never reported any, so
 * HTTP-provider logs do not carry a permanent zero.
 */
export function observerUsageLogFields(session: ActiveSession): Record<string, number> {
  return {
    cumulativeInputTokens: session.cumulativeInputTokens,
    cumulativeOutputTokens: session.cumulativeOutputTokens,
    ...(session.cumulativeCacheReadTokens
      ? { cumulativeCacheReadTokens: session.cumulativeCacheReadTokens }
      : {}),
  };
}
