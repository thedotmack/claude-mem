
import type { Observation, TokenEconomics, ContextConfig } from './types.js';
import { CHARS_PER_TOKEN_ESTIMATE } from './types.js';
import { ModeManager } from '../domain/ModeManager.js';

/** The fields the token economics read. */
export type ObservationTokenFields = Pick<Observation, 'title' | 'subtitle' | 'narrative' | 'facts' | 'discovery_tokens'>;

export function calculateObservationTokens(obs: ObservationTokenFields): number {
  const obsSize = (obs.title?.length || 0) +
                  (obs.subtitle?.length || 0) +
                  (obs.narrative?.length || 0) +
                  JSON.stringify(obs.facts || []).length;
  return Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);
}

function economicsFrom(totalObservations: number, totalReadTokens: number, totalDiscoveryTokens: number): TokenEconomics {
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

export function calculateTokenEconomics(observations: ObservationTokenFields[]): TokenEconomics {
  const totalReadTokens = observations.reduce((sum, obs) => {
    return sum + calculateObservationTokens(obs);
  }, 0);

  const totalDiscoveryTokens = observations.reduce((sum, obs) => {
    return sum + (obs.discovery_tokens || 0);
  }, 0);

  return economicsFrom(observations.length, totalReadTokens, totalDiscoveryTokens);
}

/** The economics of several batches of observations, as if calculated over all of them at once. */
export function combineTokenEconomics(parts: TokenEconomics[]): TokenEconomics {
  return economicsFrom(
    parts.reduce((sum, part) => sum + part.totalObservations, 0),
    parts.reduce((sum, part) => sum + part.totalReadTokens, 0),
    parts.reduce((sum, part) => sum + part.totalDiscoveryTokens, 0),
  );
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
