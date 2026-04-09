/**
 * HumanFormatter - Formats context output with ANSI colors for terminal
 *
 * Handles all colored formatting for context injection (terminal display).
 */

import type {
  ContextConfig,
  Observation,
  TokenEconomics,
  PriorMessages,
} from '../types.js';
import { colors } from '../types.js';
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
 * Render human-readable header
 */
export function renderHumanHeader(project: string): string[] {
  return [
    '',
    `${colors.bright}${colors.cyan}[${project}] recent context, ${formatHeaderDateTime()}${colors.reset}`,
    `${colors.gray}${'─'.repeat(60)}${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable legend
 */
export function renderHumanLegend(): string[] {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map(t => `${t.emoji} ${t.id}`).join(' | ');

  return [
    `${colors.dim}Legend: session-request | ${typeLegendItems}${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable column key
 */
export function renderHumanColumnKey(): string[] {
  return [
    `${colors.bright}Column Key${colors.reset}`,
    `${colors.dim}  Read: Tokens to read this observation (cost to learn it now)${colors.reset}`,
    `${colors.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable context index instructions
 */
export function renderHumanContextIndex(): string[] {
  return [
    `${colors.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${colors.reset}`,
    '',
    `${colors.dim}When you need implementation details, rationale, or debugging context:${colors.reset}`,
    `${colors.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${colors.reset}`,
    `${colors.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${colors.reset}`,
    `${colors.dim}  - Trust this index over re-reading code for past decisions and learnings${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable context economics
 */
export function renderHumanContextEconomics(
  economics: TokenEconomics,
  config: ContextConfig
): string[] {
  const output: string[] = [];

  output.push(`${colors.bright}${colors.cyan}Context Economics${colors.reset}`);
  output.push(`${colors.dim}  Loading: ${economics.totalObservations} observations (${economics.totalReadTokens.toLocaleString()} tokens to read)${colors.reset}`);
  output.push(`${colors.dim}  Work investment: ${economics.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${colors.reset}`);

  if (economics.totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
    let savingsLine = '  Your savings: ';
    if (config.showSavingsAmount && config.showSavingsPercent) {
      savingsLine += `${economics.savings.toLocaleString()} tokens (${economics.savingsPercent}% reduction from reuse)`;
    } else if (config.showSavingsAmount) {
      savingsLine += `${economics.savings.toLocaleString()} tokens`;
    } else {
      savingsLine += `${economics.savingsPercent}% reduction from reuse`;
    }
    output.push(`${colors.green}${savingsLine}${colors.reset}`);
  }
  output.push('');

  return output;
}

/**
 * Render human-readable day header
 */
export function renderHumanDayHeader(day: string): string[] {
  return [
    `${colors.bright}${colors.cyan}${day}${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable file header
 */
export function renderHumanFileHeader(file: string): string[] {
  return [
    `${colors.dim}${file}${colors.reset}`
  ];
}

/**
 * Render human-readable table row for observation
 */
export function renderHumanTableRow(
  obs: Observation,
  time: string,
  showTime: boolean,
  config: ContextConfig
): string {
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryTokens, workEmoji } = formatObservationTokenDisplay(obs, config);

  const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : ' '.repeat(time.length);
  const readPart = (config.showReadTokens && readTokens > 0) ? `${colors.dim}(~${readTokens}t)${colors.reset}` : '';
  const discoveryPart = (config.showWorkTokens && discoveryTokens > 0) ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : '';

  return `  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${title} ${readPart} ${discoveryPart}`;
}

/**
 * Render human-readable full observation
 */
export function renderHumanFullObservation(
  obs: Observation,
  time: string,
  showTime: boolean,
  detailField: string | null,
  config: ContextConfig
): string[] {
  const output: string[] = [];
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const { readTokens, discoveryTokens, workEmoji } = formatObservationTokenDisplay(obs, config);

  const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : ' '.repeat(time.length);
  const readPart = (config.showReadTokens && readTokens > 0) ? `${colors.dim}(~${readTokens}t)${colors.reset}` : '';
  const discoveryPart = (config.showWorkTokens && discoveryTokens > 0) ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : '';

  output.push(`  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${colors.bright}${title}${colors.reset}`);
  if (detailField) {
    output.push(`    ${colors.dim}${detailField}${colors.reset}`);
  }
  if (readPart || discoveryPart) {
    output.push(`    ${readPart} ${discoveryPart}`);
  }
  output.push('');

  return output;
}

/**
 * Render human-readable summary item in timeline
 */
export function renderHumanSummaryItem(
  summary: { id: number; request: string | null },
  formattedTime: string
): string[] {
  const summaryTitle = `${summary.request || 'Session started'} (${formattedTime})`;
  return [
    `${colors.yellow}#S${summary.id}${colors.reset} ${summaryTitle}`,
    ''
  ];
}

/**
 * Render human-readable summary field
 */
export function renderHumanSummaryField(label: string, value: string | null, color: string): string[] {
  if (!value) return [];
  return [`${color}${label}:${colors.reset} ${value}`, ''];
}

/**
 * Render human-readable previously section
 */
export function renderHumanPreviouslySection(priorMessages: PriorMessages): string[] {
  if (!priorMessages.assistantMessage) return [];

  return [
    '',
    '---',
    '',
    `${colors.bright}${colors.magenta}Previously${colors.reset}`,
    '',
    `${colors.dim}A: ${priorMessages.assistantMessage}${colors.reset}`,
    ''
  ];
}

/**
 * Render human-readable footer
 */
export function renderHumanFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `${colors.dim}Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${colors.reset}`
  ];
}

/**
 * Render human-readable empty state
 */
export function renderHumanEmptyState(project: string): string {
  return `\n${colors.bright}${colors.cyan}[${project}] recent context, ${formatHeaderDateTime()}${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
}
