/**
 * HeaderRenderer - Renders the context header sections
 *
 * Handles rendering of header, legend, column key, context index, and economics.
 */

import type { ContextConfig, TokenEconomics } from '../types.js';
import { shouldShowContextEconomics } from '../TokenCalculator.js';
import * as Markdown from '../formatters/MarkdownFormatter.js';
import * as Color from '../formatters/ColorFormatter.js';

/**
 * Render the complete header section
 */
export function renderHeader(
  project: string,
  economics: TokenEconomics,
  config: ContextConfig,
  useColors: boolean
): string[] {
  const output: string[] = [];

  // Main header
  if (useColors) {
    output.push(...Color.renderColorHeader(project));
  } else {
    output.push(...Markdown.renderMarkdownHeader(project));
  }

  // Legend
  if (useColors) {
    output.push(...Color.renderColorLegend());
  } else {
    output.push(...Markdown.renderMarkdownLegend());
  }

  // Column key
  if (useColors) {
    output.push(...Color.renderColorColumnKey());
  } else {
    output.push(...Markdown.renderMarkdownColumnKey());
  }

  // Context index instructions
  if (useColors) {
    output.push(...Color.renderColorContextIndex());
  } else {
    output.push(...Markdown.renderMarkdownContextIndex());
  }

  // Context economics
  if (shouldShowContextEconomics(config)) {
    if (useColors) {
      output.push(...Color.renderColorContextEconomics(economics, config));
    } else {
      output.push(...Markdown.renderMarkdownContextEconomics(economics, config));
    }
  }

  return output;
}
