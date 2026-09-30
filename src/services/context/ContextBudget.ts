import type { ContextConfig } from './types.js';

/**
 * Claude Code delivers a hook's stdout verbatim up to 10,000 characters. One
 * character more and the whole block is written to disk and replaced by a ~2KB
 * preview stub, so the model receives no context at all — and the hook still
 * reports success, which is why this failed silently (#3802, #1899).
 */
export const CONTEXT_OUTPUT_LIMIT = 10_000;

/**
 * Item counts cannot keep the block under that limit, because items are not a
 * fixed size: an observation title runs ~150-320 characters, a session-summary
 * line ~250-600, and the last-session summary block 1-5K on its own. Any count
 * that is safe on a quiet project wastes the budget, and any count that fills
 * the budget there overflows on a busy one.
 *
 * So fit by measuring. Render, and while the result is over budget, drop the
 * most expensive thing still in it and render again. Whole items are dropped,
 * never cut in half, so the block always ends up well-formed — the header,
 * footer and at least one observation always survive.
 */
export interface ContextBudgetResult {
  text: string;
  /** The config that produced `text`, after any reductions. */
  config: ContextConfig;
  /** Observations that survived; a prefix of the input, newest first. */
  observationCount: number;
  /** How many reduction steps were taken. 0 means the first render fit. */
  reductions: number;
  /** True when everything droppable is gone and the block is still over budget. */
  overBudget: boolean;
}

/**
 * The order things are given up in, cheapest loss first.
 *
 * Full observation narratives go first: they are the largest per-item cost and
 * their titles remain in the timeline either way. The last-session summary
 * block goes next, being a single 1-5K item. Only then do we start losing
 * timeline entries, sessions before observations, because an observation is
 * the smaller unit and the one the timeline is mostly made of.
 */
function reduceConfig(config: ContextConfig, observationCount: number): { config: ContextConfig; observationCount: number } | null {
  if (config.fullObservationCount > 0) {
    return { config: { ...config, fullObservationCount: 0 }, observationCount };
  }
  if (config.showLastSummary) {
    return { config: { ...config, showLastSummary: false }, observationCount };
  }
  if (config.sessionCount > 0) {
    return { config: { ...config, sessionCount: Math.floor(config.sessionCount / 2) }, observationCount };
  }
  if (observationCount > 1) {
    return { config, observationCount: Math.floor(observationCount / 2) };
  }
  return null;
}

/**
 * Render within `limit` characters, giving up content in `reduceConfig`'s order.
 *
 * `render` must be pure: it is called repeatedly with progressively smaller
 * inputs, and the last result that fits is the one returned.
 */
export function fitContextToBudget<T>(
  observations: T[],
  config: ContextConfig,
  render: (observations: T[], config: ContextConfig) => string,
  limit: number = CONTEXT_OUTPUT_LIMIT
): ContextBudgetResult {
  let currentConfig = config;
  let currentCount = observations.length;
  let text = render(observations, currentConfig);
  let reductions = 0;

  while (text.length > limit) {
    const next = reduceConfig(currentConfig, currentCount);
    if (!next) {
      return { text, config: currentConfig, observationCount: currentCount, reductions, overBudget: true };
    }
    currentConfig = next.config;
    currentCount = next.observationCount;
    text = render(observations.slice(0, currentCount), currentConfig);
    reductions++;
  }

  return { text, config: currentConfig, observationCount: currentCount, reductions, overBudget: false };
}
