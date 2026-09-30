
import type {
  ContextConfig,
  Observation,
  TimelineItem,
  SummaryTimelineItem,
} from '../types.js';
import { formatTime, formatDate, formatDateTime, extractFirstFile, parseJsonArray } from '../../../shared/timeline-formatting.js';
import * as Agent from '../formatters/AgentFormatter.js';
import * as Human from '../formatters/HumanFormatter.js';

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

  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
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

export function renderAgentTimeline(
  timeline: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig
): string[] {
  const output: string[] = [];
  for (const [day, dayItems] of groupTimelineByDay(timeline)) {
    output.push(...renderDayTimelineAgent(day, dayItems, fullObservationIds, config));
  }
  return output;
}

/**
 * One complete row of the human (terminal) timeline.
 *
 * Row boundaries are kept as data: titles and narratives may contain newlines
 * or text that looks like an observation ID, so rendered lines cannot tell
 * where a complete entry begins or ends. The terminal preview truncates by
 * dropping whole, oldest entries (#4252).
 */
export interface HumanTimelineEntry {
  day: string;
  file: string | null;
  lines: string[];
  /** The same row with its time shown, for when it becomes the first visible observation. */
  linesWithTime?: string[];
  summary: boolean;
}

export function buildHumanTimelineEntries(
  timeline: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string
): HumanTimelineEntry[] {
  const entries: HumanTimelineEntry[] = [];
  for (const [day, dayItems] of groupTimelineByDay(timeline)) {
    let lastTime = '';
    for (const item of dayItems) {
      if (item.type === 'summary') {
        lastTime = '';
        const summary = item.data as SummaryTimelineItem;
        entries.push({
          day, file: null, summary: true,
          lines: Human.renderHumanSummaryItem(summary, formatDateTime(summary.displayTime)),
        });
        continue;
      }
      const obs = item.data as Observation;
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      lastTime = time;
      const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
      const detail = getDetailField(obs, config);
      const full = fullObservationIds.has(obs.id);
      entries.push({
        day, file, summary: false,
        lines: full
          ? Human.renderHumanFullObservation(obs, time, showTime, detail, config)
          : [Human.renderHumanTableRow(obs, time, showTime, config)],
        linesWithTime: showTime ? undefined : full
          ? Human.renderHumanFullObservation(obs, time, true, detail, config)
          : [Human.renderHumanTableRow(obs, time, true, config)],
      });
    }
  }
  return entries;
}

/**
 * Render human entries, restoring the day and file headings and the first
 * observation's time for whichever entries are present, so a list that lost
 * its oldest entries still reads correctly.
 */
export function renderHumanTimelineEntries(entries: HumanTimelineEntry[]): string[] {
  const lines: string[] = [];
  let day = '';
  let file: string | null = null;
  let seenObservation = false;
  for (const entry of entries) {
    if (entry.day !== day) {
      if (day) lines.push('');
      lines.push(...Human.renderHumanDayHeader(entry.day));
      day = entry.day;
      file = null;
      seenObservation = false;
    }
    if (entry.summary) {
      file = null;
    } else if (entry.file !== file) {
      lines.push(...Human.renderHumanFileHeader(entry.file!));
      file = entry.file;
    }
    lines.push(...(!entry.summary && !seenObservation ? entry.linesWithTime ?? entry.lines : entry.lines));
    if (!entry.summary) seenObservation = true;
  }
  if (day) lines.push('');
  return lines;
}
