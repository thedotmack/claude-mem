/**
 * FooterRenderer - Renders the context footer sections
 *
 * Handles rendering of previously section and token savings footer.
 */

import type { ContextConfig, TokenEconomics, PriorMessages } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

/**
 * Render the previously section (prior assistant message)
 */
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
 * Render the footer with token savings info
 */
export function renderFooter(
  economics: TokenEconomics,
  config: ContextConfig,
  forHuman: boolean
): string[] {
  // Only show footer if we have savings to display
  if (!shouldShowContextEconomics(config) || economics.totalDiscoveryTokens <= 0 || economics.savings <= 0) {
    return [];
  }

  if (forHuman) {
    return Human.renderHumanFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
  }
  return Agent.renderAgentFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
}
