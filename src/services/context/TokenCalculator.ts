
import type { Observation, SessionSummary, TokenEconomics, ContextConfig } from './types.js';
import { CHARS_PER_TOKEN_ESTIMATE } from './types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';

export function calculateObservationTokens(obs: Observation): number {
  const obsSize = (obs.title?.length || 0) +
                  (obs.subtitle?.length || 0) +
                  (obs.narrative?.length || 0) +
                  JSON.stringify(obs.facts || []).length;
  return Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);
}

export function calculateTokenEconomics(observations: Observation[]): TokenEconomics {
  const totalObservations = observations.length;

  const totalReadTokens = observations.reduce((sum, obs) => {
    return sum + calculateObservationTokens(obs);
  }, 0);

  const totalDiscoveryTokens = observations.reduce((sum, obs) => {
    return sum + (obs.discovery_tokens || 0);
  }, 0);

  const savings = totalDiscoveryTokens - totalReadTokens;
  const savingsPercent = totalDiscoveryTokens > 0
    ? Math.round((savings / totalDiscoveryTokens) * 100)
    : 0;

  return {
    totalObservations,
    totalReadTokens,
    totalDiscoveryTokens,
    savings,
    savingsPercent,
  };
}

export function calculateSummaryTokens(summary: SessionSummary): number {
  return estimateTokens(summary.request) +
         estimateTokens(summary.investigated) +
         estimateTokens(summary.learned) +
         estimateTokens(summary.completed) +
         estimateTokens(summary.next_steps);
}

export interface TokenBudgetResult {
  observations: Observation[];
  observationsTrimmedByBudget: number;
}

/**
 * Greedy-fill observations newest-first until the token budget is spent.
 * Summaries are always rendered, so their estimated tokens are charged
 * against the budget before any observation is admitted. The newest
 * observation is always kept — even over budget — so a tiny budget still
 * injects context instead of nothing.
 */
export function applyTokenBudget(
  observations: Observation[],
  summaries: SessionSummary[],
  tokenBudget: number
): TokenBudgetResult {
  // NaN (e.g. a hand-edited non-numeric setting) must fail open as unlimited,
  // not trim everything.
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return { observations, observationsTrimmedByBudget: 0 };
  }

  const summaryTokens = summaries.reduce((sum, summary) => {
    return sum + calculateSummaryTokens(summary);
  }, 0);

  let remainingBudget = tokenBudget - summaryTokens;
  const keptObservations: Observation[] = [];

  for (const observation of observations) {
    const observationTokens = calculateObservationTokens(observation);
    if (keptObservations.length === 0 || observationTokens <= remainingBudget) {
      keptObservations.push(observation);
      remainingBudget -= observationTokens;
    }
  }

  return {
    observations: keptObservations,
    observationsTrimmedByBudget: observations.length - keptObservations.length,
  };
}

export function getWorkEmoji(obsType: string): string {
  return ModeManager.getInstance().getWorkEmoji(obsType);
}

export function formatObservationTokenDisplay(
  obs: Observation,
  config: ContextConfig
): { readTokens: number; discoveryTokens: number; discoveryDisplay: string; workEmoji: string } {
  const readTokens = calculateObservationTokens(obs);
  const discoveryTokens = obs.discovery_tokens || 0;
  const workEmoji = getWorkEmoji(obs.type);
  const discoveryDisplay = discoveryTokens > 0 ? `${workEmoji} ${discoveryTokens.toLocaleString()}` : '-';

  return { readTokens, discoveryTokens, discoveryDisplay, workEmoji };
}

export function shouldShowContextEconomics(config: ContextConfig): boolean {
  return config.showReadTokens || config.showWorkTokens ||
         config.showSavingsAmount || config.showSavingsPercent;
}
