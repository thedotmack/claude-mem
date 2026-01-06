/**
 * TimelineRenderer - Renders the chronological timeline of observations and summaries
 *
 * Handles day grouping, file grouping within days, and table rendering.
 */

import type {
  ContextConfig,
  Observation,
  TimelineItem,
  SummaryTimelineItem,
} from '../types.js';
import { formatTime, formatDate, formatDateTime, extractFirstFile, parseJsonArray } from '../../../shared/timeline-formatting.js';
import * as Markdown from '../formatters/MarkdownFormatter.js';
import * as Color from '../formatters/ColorFormatter.js';

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
 * Render a single day's timeline items
 */
export function renderDayTimeline(
  day: string,
  dayItems: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  useColors: boolean
): string[] {
  const output: string[] = [];

  // Day header
  if (useColors) {
    output.push(...Color.renderColorDayHeader(day));
  } else {
    output.push(...Markdown.renderMarkdownDayHeader(day));
  }

  let currentFile: string | null = null;
  let lastTime = '';
  let tableOpen = false;

  for (const item of dayItems) {
    if (item.type === 'summary') {
      // Close any open table before summary
      if (tableOpen) {
        output.push('');
        tableOpen = false;
        currentFile = null;
        lastTime = '';
      }

      const summary = item.data as SummaryTimelineItem;
      const formattedTime = formatDateTime(summary.displayTime);

      if (useColors) {
        output.push(...Color.renderColorSummaryItem(summary, formattedTime));
      } else {
        output.push(...Markdown.renderMarkdownSummaryItem(summary, formattedTime));
      }
    } else {
      const obs = item.data as Observation;
      const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
      const time = formatTime(obs.created_at);
      const showTime = time !== lastTime;
      const timeDisplay = showTime ? time : '';
      lastTime = time;

      const shouldShowFull = fullObservationIds.has(obs.id);

      // Check if we need a new file section
      if (file !== currentFile) {
        if (tableOpen) {
          output.push('');
        }

        if (useColors) {
          output.push(...Color.renderColorFileHeader(file));
        } else {
          output.push(...Markdown.renderMarkdownFileHeader(file));
        }

        currentFile = file;
        tableOpen = true;
      }

      if (shouldShowFull) {
        const detailField = getDetailField(obs, config);

        if (useColors) {
          output.push(...Color.renderColorFullObservation(obs, time, showTime, detailField, config));
        } else {
          // Close table for full observation in markdown mode
          if (tableOpen && !useColors) {
            output.push('');
            tableOpen = false;
          }
          output.push(...Markdown.renderMarkdownFullObservation(obs, timeDisplay, detailField, config));
          currentFile = null; // Reset to trigger new table header if needed
        }
      } else {
        if (useColors) {
          output.push(Color.renderColorTableRow(obs, time, showTime, config));
        } else {
          output.push(Markdown.renderMarkdownTableRow(obs, timeDisplay, config));
        }
      }
    }
  }

  // Close any remaining open table
  if (tableOpen) {
    output.push('');
  }

  return output;
}

/**
 * Render the complete timeline
 */
export function renderTimeline(
  timeline: TimelineItem[],
  fullObservationIds: Set<number>,
  config: ContextConfig,
  cwd: string,
  useColors: boolean
): string[] {
  const output: string[] = [];
  const itemsByDay = groupTimelineByDay(timeline);

  for (const [day, dayItems] of itemsByDay) {
    output.push(...renderDayTimeline(day, dayItems, fullObservationIds, config, cwd, useColors));
  }

  return output;
}
