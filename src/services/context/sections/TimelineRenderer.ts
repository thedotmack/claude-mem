
import type {
  ContextConfig,
  Observation,
  TimelineItem,
  SummaryTimelineItem,
} from '../types.js';
import { formatTime, formatDateTime, extractFirstFile, parseJsonArray, groupByDate } from '../../../shared/timeline-formatting.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

export function groupTimelineByDay(timeline: TimelineItem[]): Map<string, TimelineItem[]> {
  return groupByDate(timeline, item =>
    item.type === 'observation' ? item.data.created_at : item.data.displayTime
  );
}

function getDetailField(obs: Observation, config: ContextConfig): string | null {
  if (config.fullObservationField === 'narrative') {
    return obs.narrative;
  }
  return obs.facts ? parseJsonArray(obs.facts).join('\n') : null;
}

function renderDayTimelineAgent(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
): string[] {
  const output: string[] = [];

  output.push(...Agent.renderAgentDayHeader(day));

  let lastTime = '';

  for (const item of dayItems) {
    if (item.type === 'summary') {
      const summary = item.data as SummaryTimelineItem;
      const formattedTime = formatDateTime(summary.displayTime);
      output.push(...Agent.renderAgentSummaryItem(summary, formattedTime));
    } else {
      const obs = item.data as Observation;
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      const timeDisplay = showTime ? time : '';
      lastTime = time;

      const shouldShowFull = fullObservationIds.has(obs.id);

      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);
        output.push(...Agent.renderAgentFullObservation(obs, timeDisplay, detailField, config));
      } else {
        output.push(Agent.renderAgentTableRow(obs, timeDisplay, config));
      }
    }
  }

  return output;
}

function renderDayTimelineHuman(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
): string[] {
  const output: string[] = [];

  output.push(...Human.renderHumanDayHeader(day));

  let currentFile: string | null = null;
  let lastTime = '';

  for (const item of dayItems) {
    if (item.type === 'summary') {
      currentFile = null;
      lastTime = '';

      const summary = item.data as SummaryTimelineItem;
      const formattedTime = formatDateTime(summary.displayTime);
      output.push(...Human.renderHumanSummaryItem(summary, formattedTime));
    } else {
      const obs = item.data as Observation;
      const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      lastTime = time;

      const shouldShowFull = fullObservationIds.has(obs.id);

      if (file !== currentFile) {
        output.push(...Human.renderHumanFileHeader(file));
        currentFile = file;
      }

      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);
        output.push(...Human.renderHumanFullObservation(obs, time, showTime, detailField, config));
      } else {
        output.push(Human.renderHumanTableRow(obs, time, showTime, config));
      }
    }
  }

  output.push('');

  return output;
}

export function renderDayTimeline(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  forHuman: boolean
): string[] {
  if (forHuman) {
    return renderDayTimelineHuman(day, dayItems, fullObservationIds, config, cwd);
  }
  return renderDayTimelineAgent(day, dayItems, fullObservationIds, config);
}

export function renderTimeline(
  timeline: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  forHuman: boolean
): string[] {
  const output: string[] = [];
  const itemsByDay = groupTimelineByDay(timeline);

  for (const [day, dayItems] of itemsByDay) {
    output.push(...renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, forHuman));
  }

  return output;
}
