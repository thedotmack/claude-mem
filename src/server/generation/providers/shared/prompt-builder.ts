// SPDX-License-Identifier: Apache-2.0

import { ModeManager } from '../../../../services/domain/ModeManager.js';
import type { ModeConfig, ObservationType } from '../../../../services/domain/types.js';
import { stripTags } from '../../../../utils/tag-stripping.js';
import type { PostgresAgentEvent } from '../../../../storage/postgres/agent-events.js';
import type { ServerGenerationContext } from './types.js';

// Fallback list mirrors the default observation types used by claude-mem
// modes. The server-beta prompt does not strictly need a loaded mode file —
// the parser accepts any of these as the <type> value — so when no mode is
// loaded (tests, fresh installs) we synthesize a minimal type list rather
// than throwing.
const FALLBACK_OBSERVATION_TYPES: ReadonlyArray<Pick<ObservationType, 'id'>> = [
  { id: 'discovery' },
  { id: 'progress' },
  { id: 'blocker' },
  { id: 'decision' },
];

// Build a single-shot generation prompt from a list of AgentEvent records
// plus project/session metadata. Output: a user prompt asking the provider
// to return one or more <observation> XML blocks (or an empty response if
// the batch should be skipped). This is intentionally a single-turn request
// — server-beta does NOT use the worker's multi-turn SDK conversation
// model. parseAgentXml(...) accepts the response unchanged.
//
// Privacy: every event payload field passes through `stripTags` (which
// removes <private>, <claude-mem-context>, <system-reminder>, etc.) before
// being included in the prompt. Privacy enforcement here is belt-and-suspenders
// — `processGeneratedResponse` also discards observations that are entirely
// derived from privately-tagged inputs.

export interface BuildServerPromptResult {
  readonly prompt: string;
  readonly hadPrivateContent: boolean;
  readonly skippedAll: boolean;
}

const MAX_PAYLOAD_CHARS = 16 * 1024;

export function buildServerGenerationPrompt(
  context: ServerGenerationContext,
  options: { mode?: ModeConfig } = {},
): BuildServerPromptResult {
  const mode = options.mode ?? loadActiveModeOrFallback();

  let hadPrivateContent = false;
  let allEventsScrubbedToEmpty = true;
  const eventBlocks: string[] = [];

  for (const event of context.events) {
    const block = buildEventBlock(event);
    if (block.hadPrivate) {
      hadPrivateContent = true;
    }
    if (block.body.length > 0) {
      allEventsScrubbedToEmpty = false;
      eventBlocks.push(block.body);
    }
  }

  const skippedAll = context.events.length > 0 && allEventsScrubbedToEmpty;

  const sessionTag = context.project.serverSessionId
    ? `\n  <server_session_id>${escapeXml(context.project.serverSessionId)}</server_session_id>`
    : '';
  const projectTag = context.project.projectName
    ? `\n  <project_name>${escapeXml(context.project.projectName)}</project_name>`
    : '';

  const observationOutputSchema = buildObservationOutputSchema(mode);

  const prompt = [
    '<server_beta_observation_request>',
    `  <project_id>${escapeXml(context.project.projectId)}</project_id>`,
    `  <team_id>${escapeXml(context.project.teamId)}</team_id>` + sessionTag + projectTag,
    `  <generation_job_id>${escapeXml(context.job.id)}</generation_job_id>`,
    '  <agent_events>',
    eventBlocks.length > 0 ? eventBlocks.join('\n') : '    <!-- empty after privacy stripping -->',
    '  </agent_events>',
    '</server_beta_observation_request>',
    '',
    'You are observing an agent at work. Return one or more',
    '<observation>...</observation> XML blocks summarizing durable, useful',
    'discoveries from the events above. If the events contain nothing worth',
    'recording (e.g., everything was scrubbed by privacy filters or the',
    'activity was trivial), return a single self-closing <skip_summary />',
    'tag and nothing else. Do not include any prose outside the XML.',
    '',
    'Schema for each <observation> block:',
    observationOutputSchema,
  ].join('\n');

  return { prompt, hadPrivateContent, skippedAll };
}

interface EventBlockResult {
  body: string;
  hadPrivate: boolean;
}

function buildEventBlock(event: PostgresAgentEvent): EventBlockResult {
  const rawPayload =
    typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload ?? {}, null, 2);

  const stripResult = stripTags(rawPayload);
  const hadPrivate = (stripResult.counts.private ?? 0) > 0;
  const truncatedPayload = stripResult.stripped.length > MAX_PAYLOAD_CHARS
    ? stripResult.stripped.slice(0, MAX_PAYLOAD_CHARS) + '\n[...truncated]'
    : stripResult.stripped;

  if (truncatedPayload.trim().length === 0) {
    return { body: '', hadPrivate };
  }

  return {
    body: [
      '    <agent_event>',
      `      <id>${escapeXml(event.id)}</id>`,
      `      <event_type>${escapeXml(event.eventType)}</event_type>`,
      `      <source_adapter>${escapeXml(event.sourceAdapter)}</source_adapter>`,
      `      <occurred_at>${new Date(event.occurredAtEpoch).toISOString()}</occurred_at>`,
      '      <payload>',
      escapeXml(truncatedPayload),
      '      </payload>',
      '    </agent_event>',
    ].join('\n'),
    hadPrivate,
  };
}

function loadActiveModeOrFallback(): ModeConfig | { observation_types: ReadonlyArray<Pick<ObservationType, 'id'>> } {
  try {
    return ModeManager.getInstance().getActiveMode();
  } catch {
    return { observation_types: FALLBACK_OBSERVATION_TYPES } as unknown as ModeConfig;
  }
}

function buildObservationOutputSchema(mode: ModeConfig | { observation_types: ReadonlyArray<Pick<ObservationType, 'id'>> }): string {
  const types = mode.observation_types.map(t => t.id).join(' | ');
  return [
    '<observation>',
    `  <type>[ ${types} ]</type>`,
    '  <title>...</title>',
    '  <subtitle>...</subtitle>',
    '  <facts><fact>...</fact></facts>',
    '  <narrative>...</narrative>',
    '  <concepts><concept>...</concept></concepts>',
    '  <files_read><file>...</file></files_read>',
    '  <files_modified><file>...</file></files_modified>',
    '</observation>',
  ].join('\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
