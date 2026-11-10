
import type {
  ContextConfig,
  Observation,
  PriorMessages,
} from '../types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatObservationTokenDisplay } from '../TokenCalculator.js';
import { compactTime } from '../../../shared/timeline-formatting.js';
import { formatContextReferenceId } from './id-display.js';

export function renderAgentDayHeader(day: string): string[] {
  return [
    `### ${day}`,
  ];
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
  summary: { id: number | string; request: string | null },
  formattedTime: string,
  config: Pick<ContextConfig, 'fetchByIdSupported'> = {}
): string[] {
  return [
    `S${formatContextReferenceId(summary.id, config)} ${summary.request || 'Session started'} (${formattedTime})`,
  ];
}

export function renderAgentSummaryField(label: string, value: string | null): string[] {
  if (!value) return [];
  return [`**${label}**: ${value}`, ''];
}

/** The prior session's last reply; it goes above the timeline, which ends the agent block. */
export function renderAgentPreviouslySection(priorMessages: PriorMessages): string[] {
  if (!priorMessages.assistantMessage) return [];

  return [
    `**Previously**`,
    '',
    `A: ${priorMessages.assistantMessage}`,
    ''
  ];
}

/** The Rules + Tools line, then each lead section (health warning, open work state), then the empty timeline. */
export function renderAgentEmptyState(header: string[], leadSections: string[] = []): string {
  return [
    ...header,
    ...leadSections.filter(Boolean).flatMap(section => [section, '']),
    'No previous sessions found.',
  ].join('\n');
}
