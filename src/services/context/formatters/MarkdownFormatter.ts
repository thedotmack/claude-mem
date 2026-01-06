/**
 * MarkdownFormatter - Formats context output as markdown (non-colored mode)
 *
 * Handles all markdown formatting for context injection.
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
 * Render markdown header
 */
export function renderMarkdownHeader(project: string): string[] {
  return [
    `# [${project}] recent context, ${formatHeaderDateTime()}`,
    ''
  ];
}

/**
 * Render markdown legend
 */
export function renderMarkdownLegend(): string[] {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map(t => `${t.emoji} ${t.id}`).join(' | ');

  return [
    `**Legend:** session-request | ${typeLegendItems}`,
    ''
  ];
}

/**
 * Render markdown column key
 */
export function renderMarkdownColumnKey(): string[] {
  return [
    `**Column Key**:`,
    `- **Read**: Tokens to read this observation (cost to learn it now)`,
    `- **Work**: Tokens spent on work that produced this record ( research, building, deciding)`,
    ''
  ];
}

/**
 * Render markdown context index instructions
 */
export function renderMarkdownContextIndex(): string[] {
  return [
    `**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`,
    '',
    `When you need implementation details, rationale, or debugging context:`,
    `- Use MCP tools (search, get_observations) to fetch full observations on-demand`,
    `- Critical types ( bugfix, decision) often need detailed fetching`,
    `- Trust this index over re-reading code for past decisions and learnings`,
    ''
  ];
}

/**
 * Render markdown context economics
 */
export function renderMarkdownContextEconomics(
  economics: TokenEconomics,
  config: ContextConfig
): string[] {
  const output: string[] = [];

  output.push(`**Context Economics**:`);
  output.push(`- Loading: ${economics.totalObservations} observations (${economics.totalReadTokens.toLocaleString()} tokens to read)`);
  output.push(`- Work investment: ${economics.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions`);

  if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
    let savingsLine = '- Your savings: ';
    if (config.showSavingsAmount && config.showSavingsPercent) {
      savingsLine += `${economics.savings.toLocaleString()} tokens (${economics.savingsPercent}% reduction from reuse)`;
    } else if (config.showSavingsAmount) {
      savingsLine += `${economics.savings.toLocaleString()} tokens`;
    } else {
      savingsLine += `${economics.savingsPercent}% reduction from reuse`;
    }
    output.push(savingsLine);
  }
  output.push('');

  return output;
}

/**
 * Render markdown day header
 */
export function renderMarkdownDayHeader(day: string): string[] {
  return [
    `### ${day}`,
    ''
  ];
}

/**
 * Render markdown file header with table header
 */
export function renderMarkdownFileHeader(file: string): string[] {
  return [
    `**${file}**`,
    `| ID | Time | T | Title | Read | Work |`,
    `|----|------|---|-------|------|------|`
  ];
}

/**
 * Render markdown table row for observation
 */
export function renderMarkdownTableRow(
  obs: Observation,
  timeDisplay: string,
  config: ContextConfig
): string {
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);

  const readCol = config.showReadTokens ? `~${readTokens}` : '';
  const workCol = config.showWorkTokens ? discoveryDisplay : '';

  return `| #${obs.id} | ${timeDisplay || '"'} | ${icon} | ${title} | ${readCol} | ${workCol} |`;
}

/**
 * Render markdown full observation
 */
export function renderMarkdownFullObservation(
  obs: Observation,
  timeDisplay: string,
  detailField: string | null,
  config: ContextConfig
): string[] {
  const output: string[] = [];
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryDisplay } = formatObservationTokenDisplay(obs, config);

  output.push(`**#${obs.id}** ${timeDisplay || '"'} ${icon} **${title}**`);
  if (detailField) {
    output.push('');
    output.push(detailField);
    output.push('');
  }

  const tokenParts: string[] = [];
  if (config.showReadTokens) {
    tokenParts.push(`Read: ~${readTokens}`);
  }
  if (config.showWorkTokens) {
    tokenParts.push(`Work: ${discoveryDisplay}`);
  }
  if (tokenParts.length > 0) {
    output.push(tokenParts.join(', '));
  }
  output.push('');

  return output;
}

/**
 * Render markdown summary item in timeline
 */
export function renderMarkdownSummaryItem(
  summary: { id: number; request: string | null },
  formattedTime: string
): string[] {
  const summaryTitle = `${summary.request || 'Session started'} (${formattedTime})`;
  return [
    `**#S${summary.id}** ${summaryTitle}`,
    ''
  ];
}

/**
 * Render markdown summary field
 */
export function renderMarkdownSummaryField(label: string, value: string | null): string[] {
  if (!value) return [];
  return [`**${label}**: ${value}`, ''];
}

/**
 * Render markdown previously section
 */
export function renderMarkdownPreviouslySection(priorMessages: PriorMessages): string[] {
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
 * Render markdown footer
 */
export function renderMarkdownFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use MCP search tools to access memories by ID.`
  ];
}

/**
 * Render markdown empty state
 */
export function renderMarkdownEmptyState(project: string): string {
  return `# [${project}] recent context, ${formatHeaderDateTime()}\n\nNo previous sessions found for this project yet.`;
}
