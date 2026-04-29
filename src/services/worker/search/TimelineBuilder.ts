import { logger } from '../../../utils/logger.js';

import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  CombinedResult
} from './types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import {
  formatDate,
  formatTime,
  formatDateTime,
  extractFirstFile,
  estimateTokens
} from '../../../shared/timeline-formatting.js';

export interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;
  epoch: number;
}

export interface TimelineData {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: UserPromptSearchResult[];
}

export class TimelineBuilder {
  buildTimeline(data: TimelineData): TimelineItem[] {
    const items: TimelineItem[] = [
      ...data.observations.map(obs => ({
        type: 'observation' as const,
        data: obs,
        epoch: obs.created_at_epoch
      })),
      ...data.sessions.map(sess => ({
        type: 'session' as const,
        data: sess,
        epoch: sess.created_at_epoch
      })),
      ...data.prompts.map(prompt => ({
        type: 'prompt' as const,
        data: prompt,
        epoch: prompt.created_at_epoch
      }))
    ];

    items.sort((a, b) => a.epoch - b.epoch);
    return items;
  }

  filterByDepth(
    items: TimelineItem[],
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    if (items.length === 0) return items;

    let anchorIndex = this.findAnchorIndex(items, anchorId, anchorEpoch);

    if (anchorIndex === -1) return items;

    const startIndex = Math.max(0, anchorIndex - depthBefore);
    const endIndex = Math.min(items.length, anchorIndex + depthAfter + 1);
    return items.slice(startIndex, endIndex);
  }

  private findAnchorIndex(
    items: TimelineItem[],
    anchorId: number | string,
    anchorEpoch: number
  ): number {
    if (typeof anchorId === 'number') {
      return items.findIndex(
        item => item.type === 'observation' &&
          (item.data as ObservationSearchResult).id === anchorId
      );
    }

    if (typeof anchorId === 'string' && anchorId.startsWith('S')) {
      const sessionNum = parseInt(anchorId.slice(1), 10);
      return items.findIndex(
        item => item.type === 'session' &&
          (item.data as SessionSummarySearchResult).id === sessionNum
      );
    }

    const index = items.findIndex(item => item.epoch >= anchorEpoch);
    return index === -1 ? items.length - 1 : index;
  }

  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: {
      query?: string;
      depthBefore?: number;
      depthAfter?: number;
      cwd?: string;
    } = {}
  ): string {
    const { query, depthBefore, depthAfter, cwd = process.cwd() } = options;

    if (items.length === 0) {
      return query
        ? `Found observation matching "${query}", but no timeline context available.`
        : 'No timeline items found';
    }

    const lines: string[] = [];

    if (query && anchorId) {
      const anchorObs = items.find(
        item => item.type === 'observation' &&
          (item.data as ObservationSearchResult).id === anchorId
      );
      const anchorTitle = anchorObs
        ? ((anchorObs.data as ObservationSearchResult).title || 'Untitled')
        : 'Unknown';
      lines.push(`# Timeline for query: "${query}"`);
      lines.push(`**Anchor:** Observation #${anchorId} - ${anchorTitle}`);
    } else if (anchorId) {
      lines.push(`# Timeline around anchor: ${anchorId}`);
    } else {
      lines.push(`# Timeline`);
    }

    if (depthBefore !== undefined && depthAfter !== undefined) {
      lines.push(`**Window:** ${depthBefore} records before -> ${depthAfter} records after | **Items:** ${items.length}`);
    } else {
      lines.push(`**Items:** ${items.length}`);
    }
    lines.push('');

    const dayMap = this.groupByDay(items);
    const sortedDays = this.sortDaysChronologically(dayMap);

    for (const [day, dayItems] of sortedDays) {
      lines.push(`### ${day}`);
      lines.push('');

      let currentFile: string | null = null;
      let lastTime = '';
      let tableOpen = false;

      for (const item of dayItems) {
        const isAnchor = this.isAnchorItem(item, anchorId);

        if (item.type === 'session') {
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          const sess = item.data as SessionSummarySearchResult;
          const title = sess.request || 'Session summary';
          const marker = isAnchor ? ' <- **ANCHOR**' : '';

          lines.push(`**\uD83C\uDFAF #S${sess.id}** ${title} (${formatDateTime(item.epoch)})${marker}`);
          lines.push('');

        } else if (item.type === 'prompt') {
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          const prompt = item.data as UserPromptSearchResult;
          const truncated = prompt.prompt_text.length > 100
            ? prompt.prompt_text.substring(0, 100) + '...'
            : prompt.prompt_text;

          lines.push(`**\uD83D\uDCAC User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
          lines.push(`> ${truncated}`);
          lines.push('');

        } else if (item.type === 'observation') {
          const obs = item.data as ObservationSearchResult;
          const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);

          if (file !== currentFile) {
            if (tableOpen) {
              lines.push('');
            }

            lines.push(`**${file}**`);
            lines.push(`| ID | Time | T | Title | Tokens |`);
            lines.push(`|----|------|---|-------|--------|`);

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          const icon = ModeManager.getInstance().getTypeIcon(obs.type);
          const time = formatTime(item.epoch);
          const title = obs.title || 'Untitled';
          const tokens = estimateTokens(obs.narrative);

          const showTime = time !== lastTime;
          const timeDisplay = showTime ? time : '"';
          lastTime = time;

          const anchorMarker = isAnchor ? ' <- **ANCHOR**' : '';
          lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
        }
      }

      if (tableOpen) {
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private groupByDay(items: TimelineItem[]): Map<string, TimelineItem[]> {
    const dayMap = new Map<string, TimelineItem[]>();

    for (const item of items) {
      const day = formatDate(item.epoch);
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(item);
    }

    return dayMap;
  }

  private sortDaysChronologically(
    dayMap: Map<string, TimelineItem[]>
  ): Array<[string, TimelineItem[]]> {
    return Array.from(dayMap.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });
  }

  private isAnchorItem(item: TimelineItem, anchorId: number | string | null): boolean {
    if (anchorId === null) return false;

    if (typeof anchorId === 'number' && item.type === 'observation') {
      return (item.data as ObservationSearchResult).id === anchorId;
    }

    if (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session') {
      return `S${(item.data as SessionSummarySearchResult).id}` === anchorId;
    }

    return false;
  }
}
