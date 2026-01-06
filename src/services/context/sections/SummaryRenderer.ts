/**
 * SummaryRenderer - Renders the summary section at the end of context
 *
 * Handles rendering of the most recent session summary fields.
 */

import type { ContextConfig, Observation, SessionSummary } from '../types.js';
import { colors } from '../types.js';
import * as Markdown from '../formatters/MarkdownFormatter.js';
import * as Color from '../formatters/ColorFormatter.js';

/**
 * Check if summary should be displayed
 */
export function shouldShowSummary(
  config: ContextConfig,
  mostRecentSummary: SessionSummary | undefined,
  mostRecentObservation: Observation | undefined
): boolean {
  if (!config.showLastSummary || !mostRecentSummary) {
    return false;
  }

  const hasContent = !!(
    mostRecentSummary.investigated ||
    mostRecentSummary.learned ||
    mostRecentSummary.completed ||
    mostRecentSummary.next_steps
  );

  if (!hasContent) {
    return false;
  }

  // Only show if summary is more recent than observations
  if (mostRecentObservation && mostRecentSummary.created_at_epoch <= mostRecentObservation.created_at_epoch) {
    return false;
  }

  return true;
}

/**
 * Render summary fields
 */
export function renderSummaryFields(
  summary: SessionSummary,
  useColors: boolean
): string[] {
  const output: string[] = [];

  if (useColors) {
    output.push(...Color.renderColorSummaryField('Investigated', summary.investigated, colors.blue));
    output.push(...Color.renderColorSummaryField('Learned', summary.learned, colors.yellow));
    output.push(...Color.renderColorSummaryField('Completed', summary.completed, colors.green));
    output.push(...Color.renderColorSummaryField('Next Steps', summary.next_steps, colors.magenta));
  } else {
    output.push(...Markdown.renderMarkdownSummaryField('Investigated', summary.investigated));
    output.push(...Markdown.renderMarkdownSummaryField('Learned', summary.learned));
    output.push(...Markdown.renderMarkdownSummaryField('Completed', summary.completed));
    output.push(...Markdown.renderMarkdownSummaryField('Next Steps', summary.next_steps));
  }

  return output;
}
