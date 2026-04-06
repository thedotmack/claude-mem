/**
 * SummaryRenderer - Renders the summary section at the end of context
 *
 * Handles rendering of the most recent session summary fields.
 */

import type { ContextConfig, Observation, SessionSummary } from '../types.js';
import { colors } from '../types.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

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
  forHuman: boolean
): string[] {
  const output: string[] = [];

  if (forHuman) {
    output.push(...Human.renderHumanSummaryField('Investigated', summary.investigated, colors.blue));
    output.push(...Human.renderHumanSummaryField('Learned', summary.learned, colors.yellow));
    output.push(...Human.renderHumanSummaryField('Completed', summary.completed, colors.green));
    output.push(...Human.renderHumanSummaryField('Next Steps', summary.next_steps, colors.magenta));
  } else {
    output.push(...Agent.renderAgentSummaryField('Investigated', summary.investigated));
    output.push(...Agent.renderAgentSummaryField('Learned', summary.learned));
    output.push(...Agent.renderAgentSummaryField('Completed', summary.completed));
    output.push(...Agent.renderAgentSummaryField('Next Steps', summary.next_steps));
  }

  return output;
}
