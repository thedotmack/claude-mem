/**
 * TimelineRenderer - Renders the chronological timeline of observations and summaries
 *
 * Handles day grouping and rendering. In agent (LLM) mode, uses flat compact lines.
 * In human (terminal) mode, uses file grouping with visual formatting.
 */

import type {
  ContextConfig,
  Observation,
  TimelineItem,
  SummaryTimelineItem,
} from '../types.js';
import { formatTime, formatDate, formatDateTime, extractFirstFile, parseJsonArray } from '../../../shared/timeline-formatting.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

/**
 * Group timeline items by day
 */
export function groupTimelineByDay(timeline: TimelineItem[]): Map<string, TimelineItem[]> {
  const itemsByDay = new Map<string, TimelineItem[]>();

  for (const item of timeline) {
    const itemDate = item.type === 'observation' ? item.data.created_at : item.data.displayTime;
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day)!.push(item);
  }

  // Sort days chronologically
  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
}

/**
 * Get detail field content for full observation display
 */
function getDetailField(obs: Observation, config: ContextConfig): string | null {
  if (config.fullObservationField === 'narrative') {
    return obs.narrative;
  }
  return obs.facts ? parseJsonArray(obs.facts).join('\n') : null;
}

/**
 * Render a single day's timeline items (agent/LLM mode - flat compact lines)
 */
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

/**
 * Render a single day's timeline items (human/terminal mode - file grouped with tables)
 */
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

      // Check if we need a new file section
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

/**
 * Render a single day's timeline items
 */
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

/**
 * Render the complete timeline
 */
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
