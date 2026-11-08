
import type { ContextConfig, TokenEconomics, PriorMessages } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

export function renderPreviouslySection(
  priorMessages: PriorMessages,
  forHuman: boolean
): string[] {
  if (forHuman) {
    return Human.renderHumanPreviouslySection(priorMessages);
  }
  return Agent.renderAgentPreviouslySection(priorMessages);
}

/**
 * The terminal preview's closing line. The agent block has none: it ends on
 * its newest timeline entry, so later timeline rows can be appended to it, and
 * its Fetch and Stats lines at the top already say how to reach past work.
 */
export function renderTerminalFooter(
  economics: TokenEconomics,
  config: ContextConfig,
): string[] {
  if (!shouldShowContextEconomics(config) || economics.totalDiscoveryTokens <= 0 || economics.savings <= 0) {
    return [];
  }
  return Human.renderHumanFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
}
