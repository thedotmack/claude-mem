/**
 * FooterRenderer - Renders the context footer sections
 *
 * Handles rendering of previously section and token savings footer.
 */

import type { ContextConfig, TokenEconomics, PriorMessages } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import * as Markdown from '../formatters/MarkdownFormatter.js';
import * as Color from '../formatters/ColorFormatter.js';

/**
 * Render the previously section (prior assistant message)
 */
export function renderPreviouslySection(
  priorMessages: PriorMessages,
  useColors: boolean
): string[] {
  if (useColors) {
    return Color.renderColorPreviouslySection(priorMessages);
  }
  return Markdown.renderMarkdownPreviouslySection(priorMessages);
}

/**
 * Render the footer with token savings info
 */
export function renderFooter(
  economics: TokenEconomics,
  config: ContextConfig,
  useColors: boolean
): string[] {
  // Only show footer if we have savings to display
  if (!shouldShowContextEconomics(config) || economics.totalDiscoveryTokens <= 0 || economics.savings <= 0) {
    return [];
  }

  if (useColors) {
    return Color.renderColorFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
  }
  return Markdown.renderMarkdownFooter(economics.totalDiscoveryTokens, economics.totalReadTokens);
}
