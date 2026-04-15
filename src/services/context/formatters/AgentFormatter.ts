/**
 * AgentFormatter - Formats context output as compact markdown for LLM injection
 *
 * Optimized for token efficiency: flat lines instead of tables, no repeated headers.
 * The human-readable terminal formatter (HumanFormatter.ts) handles human-readable display separately.
 */

import type {
  ContextConfig,
  Observation,
  SessionSummary,
  TokenEconomics,
  PriorMessages,
} from '../types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatObservationTokenDisplay } from '../TokenCalculator.js';

/**
 * Format current date/time for header display
 */
function formatHeaderDateTime(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA'); // YYYY-MM-DD format
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase().replace(' ', '');
  const tz = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
  return `${date} ${time} ${tz}`;
}

/**
 * Render agent header
 */
export function renderAgentHeader(project: string): string[] {
  return [
    `# [${project}] recent context, ${formatHeaderDateTime()}`,
    ''
  ];
}

/**
 * Render agent legend
 */
export function renderAgentLegend(): string[] {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map(t => `${t.emoji}${t.id}`).join(' ');

  return [
    `Legend: 🎯session ${typeLegendItems}`,
    `Format: ID TIME TYPE TITLE`,
    `Fetch details: get_observations([IDs]) | Search: mem-search skill`,
    ''
  ];
}

/**
 * Render agent column key - no longer needed in compact format
 */
export function renderAgentColumnKey(): string[] {
  return [];
}

/**
 * Render agent context index instructions - folded into legend
 */
export function renderAgentContextIndex(): string[] {
  return [];
}

/**
 * Render agent context economics
 */
export function renderAgentContextEconomics(
  economics: TokenEconomics,
  config: ContextConfig
): string[] {
  const output: string[] = [];

  const parts: string[] = [
    `${economics.totalObservations} obs (${economics.totalReadTokens.toLocaleString()}t read)`,
    `${economics.totalDiscoveryTokens.toLocaleString()}t work`
  ];

  if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
    if (config.showSavingsPercent) {
      parts.push(`${economics.savingsPercent}% savings`);
    } else if (config.showSavingsAmount) {
      parts.push(`${economics.savings.toLocaleString()}t saved`);
    }
  }

  output.push(`Stats: ${parts.join(' | ')}`);
  output.push('');

  return output;
}

/**
 * Render agent day header
 */
export function renderAgentDayHeader(day: string): string[] {
  return [
    `### ${day}`,
  ];
}

/**
 * Render agent file header - no longer renders table headers in compact format
 */
export function renderAgentFileHeader(_file: string): string[] {
  // File grouping eliminated in compact format - file context is in observation titles
  return [];
}

/**
 * Format compact time: "9:23 AM" → "9:23a", "12:05 PM" → "12:05p"
 */
function compactTime(time: string): string {
  return time.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

/**
 * Render compact flat line for observation (replaces table row)
 */
export function renderAgentTableRow(
  obs: Observation,
  timeDisplay: string,
  _config: ContextConfig
): string {
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const time = timeDisplay ? compactTime(timeDisplay) : '"';

  return `${obs.id} ${time} ${icon} ${title}`;
}

/**
 * Render agent full observation
 */
export function renderAgentFullObservation(
  obs: Observation,
  timeDisplay: string,
  detailField: string | null,
  config: ContextConfig
): string[] {
  const output: string[] = [];
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const time = timeDisplay ? compactTime(timeDisplay) : '"';
  const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);

  output.push(`**${obs.id}** ${time} ${icon} **${title}**`);
  if (detailField) {
    output.push(detailField);
  }

  const tokenParts: string[] = [];
  if (config.showReadTokens) {
    tokenParts.push(`~${readTokens}t`);
  }
  if (config.showWorkTokens) {
    tokenParts.push(discoveryDisplay);
  }
  if (tokenParts.length > 0) {
    output.push(tokenParts.join(' '));
  }
  output.push('');

  return output;
}

/**
 * Render agent summary item in timeline
 */
export function renderAgentSummaryItem(
  summary: { id: number; request: string | null },
  formattedTime: string
): string[] {
  return [
    `S${summary.id} ${summary.request || 'Session started'} (${formattedTime})`,
  ];
}

/**
 * Render agent summary field
 */
export function renderAgentSummaryField(label: string, value: string | null): string[] {
  if (!value) return [];
  return [`**${label}**: ${value}`, ''];
}

/**
 * Render agent previously section
 */
export function renderAgentPreviouslySection(priorMessages: PriorMessages): string[] {
  if (!priorMessages.assistantMessage) return [];

  return [
    '',
    '---',
    '',
    `**Previously**`,
    '',
    `A: ${priorMessages.assistantMessage}`,
    ''
  ];
}

/**
 * Render agent footer
 */
export function renderAgentFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past work via get_observations([IDs]) or mem-search skill.`
  ];
}

/**
 * Render agent empty state
 */
export function renderAgentEmptyState(project: string): string {
  return `# [${project}] recent context, ${formatHeaderDateTime()}\n\nNo previous sessions found.`;
}
