
import type {
  ContextConfig,
  Observation,
  TokenEconomics,
  PriorMessages,
} from '../types.js';
import { colors } from '../types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatObservationTokenDisplay } from '../TokenCalculator.js';
import { formatHeaderDateTime } from '../../../shared/timeline-formatting.js';
import { formatContextReferenceId } from './id-display.js';

function formatActiveMode(): string {
  const manager = ModeManager.getInstance();
  const mode = manager.getActiveMode();
  return `${mode.name} (${manager.getActiveModeId()})`;
}

export function renderHumanHeader(project: string, headerTime: string = formatHeaderDateTime()): string[] {
  return [
    '',
    `${colors.bright}${colors.cyan}[${project}] recent context, ${headerTime}${colors.reset}`,
    `${colors.dim}Mode: ${formatActiveMode()}${colors.reset}`,
    `${colors.gray}${'─'.repeat(60)}${colors.reset}`,
    ''
  ];
}

export function renderHumanLegend(): string[] {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map(t => `${t.emoji} ${t.id}`).join(' | ');

  return [
    `${colors.dim}Legend: session-request | ${typeLegendItems}${colors.reset}`,
    ''
  ];
}

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

export function renderHumanDayHeader(day: string): string[] {
  return [
    `${colors.bright}${colors.cyan}${day}${colors.reset}`,
    ''
  ];
}

export function renderHumanFileHeader(file: string): string[] {
  return [
    `${colors.dim}${file}${colors.reset}`
  ];
}

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

  return `  ${colors.dim}#${formatContextReferenceId(obs.id, config)}${colors.reset}  ${timePart}  ${icon}  ${title} ${readPart} ${discoveryPart}`;
}

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

  output.push(`  ${colors.dim}#${formatContextReferenceId(obs.id, config)}${colors.reset}  ${timePart}  ${icon}  ${colors.bright}${title}${colors.reset}`);
  if (detailField) {
    output.push(`    ${colors.dim}${detailField}${colors.reset}`);
  }
  if (readPart || discoveryPart) {
    output.push(`    ${readPart} ${discoveryPart}`);
  }
  output.push('');

  return output;
}

export function renderHumanSummaryItem(
  summary: { id: number | string; request: string | null },
  formattedTime: string,
  config: Pick<ContextConfig, 'fetchByIdSupported'> = {}
): string[] {
  const summaryTitle = `${summary.request || 'Session started'} (${formattedTime})`;
  return [
    `${colors.yellow}#S${formatContextReferenceId(summary.id, config)}${colors.reset} ${summaryTitle}`,
    ''
  ];
}

export function renderHumanSummaryField(label: string, value: string | null, color: string): string[] {
  if (!value) return [];
  return [`${color}${label}:${colors.reset} ${value}`, ''];
}

/** The prior session's last reply; it goes above the timeline, which ends the preview. */
export function renderHumanPreviouslySection(priorMessages: PriorMessages): string[] {
  if (!priorMessages.assistantMessage) return [];

  return [
    `${colors.bright}${colors.magenta}Previously${colors.reset}`,
    '',
    `${colors.dim}A: ${priorMessages.assistantMessage}${colors.reset}`,
    ''
  ];
}

export function renderHumanEmptyState(project: string, headerTime: string = formatHeaderDateTime()): string {
  return `\n${colors.bright}${colors.cyan}[${project}] recent context, ${headerTime}${colors.reset}\n${colors.dim}Mode: ${formatActiveMode()}${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
}
