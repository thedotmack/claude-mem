
import type {
  ContextConfig,
  Observation,
  SessionSummary,
  TokenEconomics,
  PriorMessages,
} from '../types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatObservationTokenDisplay } from '../TokenCalculator.js';

function formatHeaderDateTime(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA'); 
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase().replace(' ', '');
  const tz = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
  return `${date} ${time} ${tz}`;
}

export function renderAgentHeader(project: string): string[] {
  return [
    `# [${project}] recent context, ${formatHeaderDateTime()}`,
    ''
  ];
}

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

export function renderAgentColumnKey(): string[] {
  return [];
}

export function renderAgentContextIndex(): string[] {
  return [];
}

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

export function renderAgentDayHeader(day: string): string[] {
  return [
    `### ${day}`,
  ];
}

export function renderAgentFileHeader(_file: string): string[] {
  return [];
}

function compactTime(time: string): string {
  return time.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

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

export function renderAgentSummaryItem(
  summary: { id: number; request: string | null },
  formattedTime: string
): string[] {
  return [
    `S${summary.id} ${summary.request || 'Session started'} (${formattedTime})`,
  ];
}

export function renderAgentSummaryField(label: string, value: string | null): string[] {
  if (!value) return [];
  return [`**${label}**: ${value}`, ''];
}

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

export function renderAgentFooter(totalDiscoveryTokens: number, totalReadTokens: number): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  return [
    '',
    `Access ${workTokensK}k tokens of past work via get_observations([IDs]) or mem-search skill.`
  ];
}

export function renderAgentEmptyState(project: string): string {
  return `# [${project}] recent context, ${formatHeaderDateTime()}\n\nNo previous sessions found.`;
}
