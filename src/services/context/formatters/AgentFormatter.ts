
import type {
  ContextConfig,
  Observation,
  SessionSummary,
  TokenEconomics,
  PriorMessages,
} from '../types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatObservationTokenDisplay } from '../TokenCalculator.js';
import { formatIsoDate } from '../../../shared/timeline-formatting.js';
import { formatContextReferenceId } from './id-display.js';
import { buildToolSearchSelectArg } from '../../../shared/mcp-constants.js';

export function renderAgentHeader(project: string): string[] {
  const date = formatIsoDate();
  return [
    `# [${project}] recent context, ${date}`,
    ''
  ];
}

export function renderAgentLegend(fetchByIdSupported: boolean = true): string[] {
  const mode = ModeManager.getInstance().getActiveMode();
  const typeLegendItems = mode.observation_types.map(t => `${t.emoji}${t.id}`).join(' ');
  const fetchLine = fetchByIdSupported
    ? `Fetch details: get_observations([IDs]) | Search: mem-search skill`
    : `Fetch details: mem-search by title/context (short refs are display-only)`;
  const memSearchLine = fetchByIdSupported
    ? `mem-search: load tools with ToolSearch select:${buildToolSearchSelectArg()} first, then search -> timeline -> get_observations([ids]) in batches.`
    : `mem-search: search by title/context first; short refs are display-only, so avoid direct ID fetches from this context.`;

  return [
    `Legend: 🎯session ${typeLegendItems}`,
    `Format: ID TIME TYPE TITLE`,
    fetchLine,
    '',
    memSearchLine,
    `Planning: for multi-step work, invoke /make-plan so it writes a phased plan file to plans/inbox/, then execute with /do after review.`,
    `Subagents: fan out independent fact-gathering work in parallel; orchestrator synthesizes decisions from source and file:line evidence.`,
    ''
  ];
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

function compactTime(time: string): string {
  return time.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

export function renderAgentTableRow(
  obs: Observation,
  timeDisplay: string,
  config: ContextConfig
): string {
  const title = obs.title || 'Untitled';
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const time = timeDisplay ? compactTime(timeDisplay) : '"';
  const refId = formatContextReferenceId(obs.id, config);

  return `${refId} ${time} ${icon} ${title}`;
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
  const refId = formatContextReferenceId(obs.id, config);

  output.push(`**${refId}** ${time} ${icon} **${title}**`);
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

export function renderAgentFooter(
  totalDiscoveryTokens: number,
  totalReadTokens: number,
  fetchByIdSupported: boolean = true
): string[] {
  const workTokensK = Math.round(totalDiscoveryTokens / 1000);
  const accessHint = fetchByIdSupported
    ? 'get_observations([IDs]) or mem-search skill'
    : 'mem-search skill';
  return [
    '',
    `Access ${workTokensK}k tokens of past work via ${accessHint}.`
  ];
}

export function renderAgentEmptyState(project: string): string {
  const date = formatIsoDate();
  return `# [${project}] recent context, ${date}\n\nNo previous sessions found.`;
}
